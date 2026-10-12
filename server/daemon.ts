import { Agent, type ClientRequestArgs } from "node:http";
import { createConnection } from "node:net";
import type { Duplex } from "node:stream";
import WebSocket from "ws";
import { config } from "./config.js";

class UnixSocketAgent extends Agent {
  constructor(private readonly socketPath: string) {
    super({ keepAlive: false });
  }

  override createConnection(_options: ClientRequestArgs): Duplex {
    return createConnection({ path: this.socketPath });
  }
}

function socketOptions(): WebSocket.ClientOptions {
  const headers: Record<string, string> = {};
  if (config.endpoint.kind === "websocket" && config.endpoint.authToken) {
    headers.Authorization = `Bearer ${config.endpoint.authToken}`;
  }

  return {
    headers,
    handshakeTimeout: config.connectTimeoutMs,
    maxPayload: config.maxPayloadBytes,
    perMessageDeflate: false,
  };
}

export function connectDaemon(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    let socket: WebSocket;
    const agent =
      config.endpoint.kind === "unix"
        ? new UnixSocketAgent(config.endpoint.path)
        : undefined;
    try {
      socket = new WebSocket(
        config.endpoint.kind === "unix"
          ? "ws://localhost/rpc"
          : config.endpoint.url.toString(),
        { ...socketOptions(), ...(agent ? { agent } : {}) },
      );
    } catch (error) {
      agent?.destroy();
      reject(error);
      return;
    }

    const connectedSocketErrorHandler = () => {};
    socket.on("error", connectedSocketErrorHandler);
    socket.once("close", () => {
      agent?.destroy();
      socket.removeListener("error", connectedSocketErrorHandler);
    });
    const onError = (error: Error) => {
      socket.removeListener("open", onOpen);
      reject(error);
    };
    const onOpen = () => {
      socket.removeListener("error", onError);
      resolve(socket);
    };
    socket.once("error", onError);
    socket.once("open", onOpen);
  });
}

let statusCache: { checkedAt: number; available: boolean } | undefined;
let statusInFlight: Promise<boolean> | undefined;

async function probeDaemon(): Promise<boolean> {
  try {
    const socket = await connectDaemon();
    return await new Promise((resolve) => {
      const finish = (available: boolean) => {
        clearTimeout(timeout);
        socket.removeListener("error", onError);
        socket.removeListener("close", onClose);
        resolve(available);
      };
      const onError = () => finish(false);
      const onClose = () => finish(true);
      const timeout = setTimeout(() => {
        socket.terminate();
        finish(false);
      }, config.connectTimeoutMs);
      timeout.unref();
      socket.once("error", onError);
      socket.once("close", onClose);
      socket.close(1000, "status probe");
    });
  } catch {
    return false;
  }
}

export async function daemonAvailable(): Promise<boolean> {
  const now = Date.now();
  if (statusCache && now - statusCache.checkedAt < 2000)
    return statusCache.available;
  statusInFlight ??= probeDaemon().finally(() => {
    statusInFlight = undefined;
  });
  const available = await statusInFlight;
  statusCache = { checkedAt: Date.now(), available };
  return available;
}

export function endpointLabel(): string {
  return config.endpoint.label;
}
