import type { RpcError, RpcId } from "./types";

export type ConnectionState =
  "connecting" | "online" | "reconnecting" | "offline";

type RpcClientOptions = {
  onState: (state: ConnectionState, message?: string) => void;
  onDisconnected: () => void;
  onNotification: (method: string, params: Record<string, unknown>) => void;
  onServerRequest: (request: {
    id: RpcId;
    method: string;
    params: Record<string, unknown>;
  }) => void;
  onReady: () => void;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timeout: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asError(error: RpcError): Error {
  const result = new Error(error.message);
  Object.assign(result, { code: error.code, data: error.data });
  return result;
}

export class RpcClient {
  private socket: WebSocket | null = null;
  private pending = new Map<RpcId, PendingRequest>();
  private sequence = 0;
  private retryTimer: number | undefined;
  private retryAttempt = 0;
  private closed = false;
  private ready = false;
  private bridgeError = "";

  constructor(private options: RpcClientOptions) {
    this.open();
  }

  request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (
      !this.ready ||
      !this.socket ||
      this.socket.readyState !== WebSocket.OPEN
    ) {
      return Promise.reject(
        new Error(
          "Codex is reconnecting. Wait for the connection before sending.",
        ),
      );
    }

    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex did not answer ${method} in time.`));
      }, 90_000);

      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timeout,
      });

      try {
        this.socket?.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        window.clearTimeout(timeout);
        this.pending.delete(id);
        reject(
          error instanceof Error
            ? error
            : new Error("Could not send the request."),
        );
      }
    });
  }

  respond(id: RpcId, result: unknown): void {
    this.sendServerReply({ id, result });
  }

  reject(id: RpcId, error: RpcError): void {
    this.sendServerReply({ id, error });
  }

  close(): void {
    this.closed = true;
    this.ready = false;
    if (this.retryTimer !== undefined) window.clearTimeout(this.retryTimer);
    this.socket?.close();
    this.socket = null;
    this.failPending(new Error("The Codex connection was closed."));
  }

  private open(): void {
    if (this.closed) return;
    this.ready = false;
    this.options.onState(
      this.retryAttempt === 0 ? "connecting" : "reconnecting",
    );
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(
      `${protocol}//${window.location.host}/api/rpc`,
    );
    this.socket = socket;

    socket.onopen = () => {
      this.options.onState("connecting", "Waiting for the daemon bridge…");
    };

    socket.onmessage = (event) => {
      this.receive(String(event.data));
    };

    socket.onerror = () => {
      this.options.onState(
        "reconnecting",
        "Connection interrupted. Reconnecting…",
      );
    };

    socket.onclose = () => {
      if (this.socket === socket) this.socket = null;
      this.ready = false;
      this.failPending(
        new Error(
          "The connection was interrupted. Your message was not retried.",
        ),
      );
      if (!this.closed) {
        this.options.onDisconnected();
        this.options.onState(
          "reconnecting",
          this.bridgeError || "Connection interrupted. Reconnecting…",
        );
        this.bridgeError = "";
        this.scheduleRetry();
      }
    };
  }

  private scheduleRetry(): void {
    if (this.retryTimer !== undefined || this.closed) return;
    const delay = Math.min(15_000, 700 * 2 ** Math.min(this.retryAttempt, 4));
    this.retryAttempt += 1;
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = undefined;
      this.open();
    }, delay);
  }

  private receive(raw: string): void {
    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      this.options.onState(
        "reconnecting",
        "The daemon sent an unreadable response.",
      );
      return;
    }
    if (!isRecord(message)) return;

    if (message.method === "bridge/ready") {
      this.ready = true;
      this.retryAttempt = 0;
      this.options.onState("online");
      this.options.onReady();
      return;
    }
    if (message.method === "bridge/error") {
      const params = isRecord(message.params) ? message.params : {};
      const detail =
        typeof params.message === "string"
          ? params.message
          : "The local daemon bridge reported an error.";
      this.options.onState("reconnecting", detail);
      this.bridgeError = detail;
      this.socket?.close(1011, "Local bridge error");
      return;
    }
    if (typeof message.method === "string") {
      const params = isRecord(message.params) ? message.params : {};
      if ("id" in message) {
        this.options.onServerRequest({
          id: message.id as RpcId,
          method: message.method,
          params,
        });
      } else {
        this.options.onNotification(message.method, params);
      }
      return;
    }

    if ("id" in message) {
      const pending = this.pending.get(message.id as RpcId);
      if (!pending) return;
      this.pending.delete(message.id as RpcId);
      window.clearTimeout(pending.timeout);
      if (isRecord(message.error)) {
        pending.reject(
          asError({
            code:
              typeof message.error.code === "number"
                ? message.error.code
                : -32000,
            message:
              typeof message.error.message === "string"
                ? message.error.message
                : "Codex returned an error.",
            data: message.error.data,
          }),
        );
      } else {
        pending.resolve(message.result);
      }
    }
  }

  private sendServerReply(reply: {
    id: RpcId;
    result?: unknown;
    error?: RpcError;
  }): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(reply));
  }

  private failPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      window.clearTimeout(pending.timeout);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}
