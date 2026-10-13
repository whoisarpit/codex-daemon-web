import type { IncomingMessage, Server } from "node:http";
import type { Request } from "express";
import { WebSocket, WebSocketServer } from "ws";
import {
  authenticatedSession,
  isSessionActive,
  onSessionRevoked,
  sessionExpiresAt,
} from "./auth.js";
import { config } from "./config.js";
import { connectDaemon } from "./daemon.js";
import { notifyUserInput } from "./push.js";

const upstreamInitId = "codex-daemon-web-initialize";
const maxBufferedBytes = 2 * 1024 * 1024;
const notifiedRequests = new Map<string, number>();

function observeUserInputRequest(text: string): void {
  let packet: unknown;
  try {
    packet = JSON.parse(text);
  } catch {
    return;
  }
  if (!isJsonObject(packet) || packet.method !== "item/tool/requestUserInput")
    return;
  if (typeof packet.id !== "string" && typeof packet.id !== "number") {
    return;
  }
  if (!isJsonObject(packet.params)) return;
  const threadId = packet.params.threadId;
  const turnId = packet.params.turnId;
  const itemId = packet.params.itemId;
  if (
    typeof threadId !== "string" ||
    threadId.length === 0 ||
    threadId.length > 256 ||
    typeof turnId !== "string" ||
    turnId.length === 0 ||
    turnId.length > 256 ||
    typeof itemId !== "string" ||
    itemId.length === 0 ||
    itemId.length > 256
  ) {
    return;
  }

  const now = Date.now();
  for (const [requestKey, observedAt] of notifiedRequests) {
    if (now - observedAt > 60 * 60 * 1000) notifiedRequests.delete(requestKey);
  }
  const requestKey = JSON.stringify([threadId, turnId, itemId]);
  if (notifiedRequests.has(requestKey)) return;
  notifiedRequests.set(requestKey, now);
  while (notifiedRequests.size > 1000) {
    const oldest = notifiedRequests.keys().next().value;
    if (oldest === undefined) break;
    notifiedRequests.delete(oldest);
  }
  notifyUserInput(threadId);
}

function sendBridgeMessage(
  socket: WebSocket,
  method: string,
  message: string,
): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ method, params: { message } }), {
    binary: false,
  });
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeForward(
  source: WebSocket,
  target: WebSocket,
  text: string,
): boolean {
  if (
    source.readyState !== WebSocket.OPEN ||
    target.readyState !== WebSocket.OPEN
  )
    return false;
  if (
    target.bufferedAmount + Buffer.byteLength(text, "utf8") >
    maxBufferedBytes
  ) {
    target.close(1013, "client is not keeping up");
    return false;
  }
  target.send(text, { binary: false }, (error) => {
    if (error && target.readyState === WebSocket.OPEN)
      target.close(1011, "bridge send failed");
  });
  return true;
}

function rejectUpgrade(
  request: IncomingMessage,
  status: number,
  message: string,
): void {
  const response = `HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`;
  request.socket.write(response);
  request.socket.destroy();
}

function attachHeartbeat(socket: WebSocket, onTimeout: () => void): () => void {
  let stopped = false;
  let pongTimer: ReturnType<typeof setTimeout> | undefined;
  const heartbeatTimer = setInterval(() => {
    if (socket.readyState !== WebSocket.OPEN) {
      stop();
      return;
    }
    try {
      socket.ping(undefined, undefined, (error) => {
        if (error) expire();
      });
      pongTimer = setTimeout(expire, 10_000);
      pongTimer.unref();
    } catch {
      expire();
    }
  }, 30_000);
  heartbeatTimer.unref();

  const onPong = () => {
    if (pongTimer) clearTimeout(pongTimer);
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(heartbeatTimer);
    if (pongTimer) clearTimeout(pongTimer);
    socket.removeListener("pong", onPong);
    socket.removeListener("close", stop);
  };
  const expire = () => {
    if (stopped) return;
    stop();
    onTimeout();
  };

  socket.on("pong", onPong);
  socket.once("close", stop);
  return stop;
}

function forwardSocketPair(browser: WebSocket, sessionId: string): void {
  let upstream: WebSocket | undefined;
  let ready = false;
  let intentionalUpstreamClose = false;
  let sessionRevoked = false;
  let initializeTimer: ReturnType<typeof setTimeout> | undefined;
  let sessionExpiryTimer: ReturnType<typeof setTimeout> | undefined;
  let upstreamHeartbeatCleanup = () => {};
  const pendingMessages: string[] = [];

  const browserHeartbeatCleanup = attachHeartbeat(browser, () => {
    intentionalUpstreamClose = true;
    browser.terminate();
    if (upstream && upstream.readyState < WebSocket.CLOSING) {
      upstream.close(1001, "browser heartbeat timed out");
    }
  });

  const closeForRevocation = () => {
    sessionRevoked = true;
    if (browser.readyState === WebSocket.OPEN)
      browser.close(1008, "session expired or logged out");
    if (upstream && upstream.readyState < WebSocket.CLOSING) {
      intentionalUpstreamClose = true;
      upstream.close(1008, "session expired or logged out");
    }
  };
  const detachRevocationListener = onSessionRevoked((revokedSession) => {
    if (revokedSession === sessionId) closeForRevocation();
  });
  const expiry = sessionExpiresAt(sessionId);
  if (expiry === undefined) {
    closeForRevocation();
    detachRevocationListener();
    browserHeartbeatCleanup();
    return;
  }
  sessionExpiryTimer = setTimeout(
    () => {
      if (!isSessionActive(sessionId)) closeForRevocation();
    },
    Math.max(1, expiry - Date.now() + 1),
  );
  sessionExpiryTimer.unref();

  const sessionIsValid = () => {
    if (sessionRevoked) return false;
    if (!isSessionActive(sessionId)) {
      closeForRevocation();
      return false;
    }
    return true;
  };

  const fail = (message: string) => {
    sendBridgeMessage(browser, "bridge/error", message);
    if (browser.readyState === WebSocket.OPEN)
      browser.close(1011, "bridge unavailable");
    if (upstream && upstream.readyState < WebSocket.CLOSING) {
      intentionalUpstreamClose = true;
      upstream.close(1011, "bridge unavailable");
    }
  };

  browser.on("message", (data, isBinary) => {
    if (!sessionIsValid()) return;
    if (isBinary) {
      browser.close(1003, "JSON text frames are required");
      return;
    }
    if (!ready || !upstream || upstream.readyState !== WebSocket.OPEN) {
      browser.close(1008, "bridge is not ready");
      return;
    }

    const text = data.toString("utf8");
    let packet: unknown;
    try {
      packet = JSON.parse(text);
    } catch {
      browser.close(1007, "invalid JSON message");
      return;
    }
    if (!isJsonObject(packet)) {
      browser.close(1007, "JSON-RPC messages must be objects");
      return;
    }
    if (packet.method === "initialize" || packet.method === "initialized") {
      browser.close(1008, "the bridge owns app-server initialization");
      return;
    }
    if ("method" in packet && typeof packet.method !== "string") {
      browser.close(1007, "invalid JSON-RPC method");
      return;
    }
    safeForward(browser, upstream, text);
  });

  browser.on("close", () => {
    if (initializeTimer) clearTimeout(initializeTimer);
    if (sessionExpiryTimer) clearTimeout(sessionExpiryTimer);
    detachRevocationListener();
    browserHeartbeatCleanup();
    upstreamHeartbeatCleanup();
    if (upstream && upstream.readyState < WebSocket.CLOSING) {
      intentionalUpstreamClose = true;
      upstream.close(1000, "browser disconnected");
    }
  });
  browser.on("error", () => {
    if (upstream && upstream.readyState < WebSocket.CLOSING) {
      intentionalUpstreamClose = true;
      upstream.close(1011, "browser connection failed");
    }
  });

  void (async () => {
    try {
      upstream = await connectDaemon();
      if (browser.readyState !== WebSocket.OPEN || !sessionIsValid()) {
        intentionalUpstreamClose = true;
        upstream.close(1000, "browser disconnected");
        return;
      }

      upstreamHeartbeatCleanup = attachHeartbeat(upstream, () =>
        fail("Codex app-server heartbeat timed out"),
      );

      upstream.on("message", (data, isBinary) => {
        if (!sessionIsValid()) return;
        if (isBinary) {
          fail("Codex app-server returned a non-text message");
          return;
        }
        const text = data.toString("utf8");
        observeUserInputRequest(text);
        if (!ready) {
          let packet: unknown;
          try {
            packet = JSON.parse(text);
          } catch {
            fail(
              "Codex app-server returned an invalid initialization response",
            );
            return;
          }
          if (isJsonObject(packet) && packet.id === upstreamInitId) {
            if ("error" in packet || !("result" in packet)) {
              fail("Codex app-server rejected initialization");
              return;
            }
            ready = true;
            if (initializeTimer) clearTimeout(initializeTimer);
            upstream?.send(
              JSON.stringify({ method: "initialized", params: {} }),
            );
            browser.send(
              JSON.stringify({ method: "bridge/ready", params: {} }),
              { binary: false },
            );
            for (const pending of pendingMessages.splice(0)) {
              if (!safeForward(upstream!, browser, pending)) break;
            }
            return;
          }
          if (pendingMessages.length >= 32) {
            fail(
              "Codex app-server sent too many messages during initialization",
            );
            return;
          }
          pendingMessages.push(text);
          return;
        }
        safeForward(upstream!, browser, text);
      });

      upstream.on("close", () => {
        if (initializeTimer) clearTimeout(initializeTimer);
        upstreamHeartbeatCleanup();
        if (
          !intentionalUpstreamClose &&
          browser.readyState === WebSocket.OPEN
        ) {
          sendBridgeMessage(
            browser,
            "bridge/error",
            "Codex app-server connection closed",
          );
          browser.close(1011, "app-server connection closed");
        }
      });
      upstream.on("error", () => {
        if (!intentionalUpstreamClose)
          fail("Codex app-server connection failed");
      });

      const initialization = JSON.stringify({
        id: upstreamInitId,
        method: "initialize",
        params: {
          clientInfo: {
            name: "codex-daemon-web",
            title: "Codex Daemon Web",
            version: "0.1.0",
          },
          capabilities: { experimentalApi: true },
        },
      });
      initializeTimer = setTimeout(() => {
        if (!ready) fail("Codex app-server initialization timed out");
      }, config.initializeTimeoutMs);
      initializeTimer.unref();
      upstream.send(initialization, { binary: false }, (error) => {
        if (error) fail("Could not initialize Codex app-server connection");
      });
    } catch {
      fail("Codex app-server is unavailable");
    }
  })();
}

export function attachBridge(server: Server): () => void {
  const socketSessions = new WeakMap<WebSocket, string>();
  const websocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: config.maxPayloadBytes,
    perMessageDeflate: false,
  });

  server.on("upgrade", (request, socket, head) => {
    let path: string;
    try {
      path = new URL(request.url || "/", "http://localhost").pathname;
    } catch {
      rejectUpgrade(request, 400, "Bad Request");
      return;
    }
    if (path !== "/api/rpc") {
      rejectUpgrade(request, 404, "Not Found");
      return;
    }

    const origin = request.headers.origin;
    if (!origin || !config.allowedOrigins.has(origin)) {
      rejectUpgrade(request, 403, "Forbidden");
      return;
    }
    const sessionId = authenticatedSession(request as unknown as Request);
    if (!sessionId) {
      rejectUpgrade(request, 401, "Unauthorized");
      return;
    }

    websocketServer.handleUpgrade(request, socket, head, (browser) => {
      socketSessions.set(browser, sessionId);
      websocketServer.emit("connection", browser, request);
    });
  });

  websocketServer.on("connection", (browser) => {
    const sessionId = socketSessions.get(browser);
    if (!sessionId) {
      browser.close(1008, "missing session");
      return;
    }
    forwardSocketPair(browser, sessionId);
  });
  return () => {
    for (const browser of websocketServer.clients) {
      browser.close(1001, "server is shutting down");
    }
    websocketServer.close();
  };
}
