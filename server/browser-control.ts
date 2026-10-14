import { createConnection } from "node:net";

const socketPath =
  process.env.CODEX_WEB_BROWSER_SOCKET ??
  "/browser-socket/codex-web-browser-backend.sock";
const maxFrameBytes = 8 * 1024 * 1024;

export type BrowserMethod =
  | "webGetTabs"
  | "webScreenshot"
  | "webActivateTab"
  | "webNewTab"
  | "webNavigate"
  | "webReload"
  | "webBack"
  | "webClick"
  | "webScroll"
  | "webType"
  | "webKey";

export interface BrowserTab {
  id: number;
  title: string;
  url: string;
  active: boolean;
}

export interface BrowserScreenshot {
  data: string;
  width: number;
  height: number;
  title: string;
  url: string;
}

export class BrowserBackendError extends Error {}

export function callBrowserBackend<T>(
  session: string,
  method: BrowserMethod,
  params: Record<string, unknown> = {},
): Promise<T> {
  const socket = createConnection(socketPath);
  const requestId = 1;
  let input = Buffer.alloc(0);
  let settled = false;
  let timer: NodeJS.Timeout | undefined;

  return new Promise<T>((resolve, reject) => {
    const finish = (error?: Error, result?: T) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(result as T);
    };

    timer = setTimeout(
      () => finish(new BrowserBackendError("The browser did not respond")),
      15_000,
    );

    socket.once("connect", () => {
      const payload = Buffer.from(
        JSON.stringify({
          jsonrpc: "2.0",
          id: requestId,
          method,
          params: { ...params, session_id: session },
        }),
      );
      if (payload.length > maxFrameBytes) {
        finish(new BrowserBackendError("The browser request is too large"));
        return;
      }
      const frame = Buffer.allocUnsafe(payload.length + 4);
      frame.writeUInt32LE(payload.length, 0);
      payload.copy(frame, 4);
      socket.write(frame);
    });

    socket.on("data", (chunk) => {
      input = Buffer.concat([input, chunk]);
      while (input.length >= 4) {
        const frameLength = input.readUInt32LE(0);
        if (frameLength > maxFrameBytes) {
          finish(new BrowserBackendError("The browser response is too large"));
          return;
        }
        if (input.length < frameLength + 4) return;
        const frame = input.subarray(4, frameLength + 4);
        input = input.subarray(frameLength + 4);
        let response: unknown;
        try {
          response = JSON.parse(frame.toString("utf8"));
        } catch {
          finish(
            new BrowserBackendError("The browser returned an invalid response"),
          );
          return;
        }
        if (!response || typeof response !== "object") continue;
        const value = response as {
          id?: unknown;
          result?: T;
          error?: { message?: unknown };
        };
        if (value.id !== requestId) continue;
        if (value.error) {
          finish(
            new BrowserBackendError(
              typeof value.error.message === "string"
                ? value.error.message
                : "The browser request failed",
            ),
          );
        } else {
          finish(undefined, value.result);
        }
        return;
      }
    });

    socket.once("error", (error) =>
      finish(
        error instanceof Error
          ? new BrowserBackendError("The Codex browser service is unavailable")
          : new BrowserBackendError(String(error)),
      ),
    );
    socket.once("close", () => {
      if (!settled) {
        finish(new BrowserBackendError("The browser connection closed"));
      }
    });
  });
}

export function writeBrowserError(
  error: unknown,
  response: import("express").Response,
): void {
  const message =
    error instanceof BrowserBackendError
      ? error.message
      : "The browser request failed";
  response
    .status(503)
    .json({ error: "The Codex browser service is unavailable." });
}
