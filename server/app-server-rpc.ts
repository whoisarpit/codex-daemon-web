import WebSocket from "ws";
import { connectDaemon } from "./daemon.js";

type JsonRecord = Record<string, unknown>;
type RpcError = { code?: number; message?: string; data?: unknown };

type PendingRequest = {
  method: string;
  sent: boolean;
  timeout: NodeJS.Timeout;
  resolve: (value: unknown) => void;
  reject: (error: AppServerRpcError) => void;
};

export class AppServerRpcError extends Error {
  constructor(
    readonly method: string,
    message: string,
    readonly sent: boolean,
    readonly ambiguous: boolean,
  ) {
    super(message);
    this.name = "AppServerRpcError";
  }
}

export class AmbiguousTurnError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AmbiguousTurnError";
  }
}

export class AppServerRpc {
  private readonly pending = new Map<number, PendingRequest>();
  private readonly completedTurns = new Map<string, JsonRecord>();
  private readonly completionWaiters = new Map<
    string,
    { resolve: (turn: JsonRecord) => void; reject: (error: Error) => void }
  >();
  private sequence = 0;
  private permissionDenied = false;
  private closed = false;
  private readonly ready: Promise<void>;

  private constructor(
    private readonly socket: WebSocket,
    private readonly onThreadStarted?: (threadId: string) => Promise<void>,
  ) {
    this.socket.on("message", (data, isBinary) => {
      if (isBinary)
        return this.closeWithError("The app-server returned binary data");
      this.receive(data.toString("utf8"));
    });
    this.socket.on("error", () =>
      this.closeWithError("The app-server connection failed"),
    );
    this.socket.on("close", () =>
      this.closeWithError("The app-server connection closed"),
    );
    this.ready = this.initialize();
  }

  static async connect(
    onThreadStarted?: (threadId: string) => Promise<void>,
  ): Promise<AppServerRpc> {
    const socket = await connectDaemon();
    const client = new AppServerRpc(socket, onThreadStarted);
    await client.ready;
    return client;
  }

  async startTaskTurn(task: {
    mode: "sameChat" | "newChat";
    sourceThreadId: string | null;
    cwd: string | null;
    prompt: string;
    model: string | null;
    reasoningEffort: string | null;
  }): Promise<{ threadId: string; summary: string; status: string }> {
    await this.ready;
    let threadId: string;
    if (task.mode === "sameChat") {
      if (!task.sourceThreadId)
        throw new Error("The task has no saved conversation");
      const resumed = await this.request<JsonRecord>("thread/resume", {
        threadId: task.sourceThreadId,
      });
      const thread = asRecord(resumed.thread);
      const status = asRecord(thread?.status);
      if (status?.type === "active") throw new ActiveThreadError();
      threadId = task.sourceThreadId;
      await this.onThreadStarted?.(threadId);
    } else {
      if (!task.cwd) throw new Error("The task has no working directory");
      const params: JsonRecord = { cwd: task.cwd };
      if (task.model) params.model = task.model;
      const started = await this.request<JsonRecord>("thread/start", params);
      const thread = asRecord(started.thread);
      threadId = typeof thread?.id === "string" ? thread.id : "";
      if (!threadId)
        throw new Error("Codex did not return the new conversation id");
      await this.onThreadStarted?.(threadId);
    }

    const turnParams: JsonRecord = {
      threadId,
      input: [{ type: "text", text: task.prompt, text_elements: [] }],
    };
    if (task.model) turnParams.model = task.model;
    if (task.reasoningEffort) turnParams.effort = task.reasoningEffort;
    const startedTurn = await this.request<JsonRecord>(
      "turn/start",
      turnParams,
    );
    const turn = asRecord(startedTurn.turn);
    if (!turn || typeof turn.id !== "string")
      throw new Error("Codex did not return the scheduled turn id");
    const turnId = turn.id;
    const status =
      typeof turn?.status === "string" ? turn.status : "inProgress";
    let completed: JsonRecord;
    try {
      completed =
        status === "inProgress"
          ? await this.waitForTurn(threadId, turnId)
          : turn;
    } catch (error) {
      throw new AmbiguousTurnError(
        error instanceof Error
          ? error.message
          : "Codex did not confirm turn completion",
      );
    }
    const completedStatus =
      typeof completed.status === "string" ? completed.status : status;
    const summary = assistantText(completed.items);
    if (this.permissionDenied)
      throw new Error(
        "The run requested user approval. No approval was granted.",
      );
    if (completedStatus !== "completed")
      throw new Error(
        `Codex finished the scheduled turn with status ${completedStatus}`,
      );
    return { threadId, summary, status: completedStatus };
  }

  close(): void {
    this.closed = true;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(
        new AppServerRpcError(
          pending.method,
          "The app-server connection closed",
          pending.sent,
          pending.sent,
        ),
      );
      this.pending.delete(id);
    }
    for (const waiter of this.completionWaiters.values())
      waiter.reject(
        new Error("The app-server connection closed before the turn completed"),
      );
    this.completionWaiters.clear();
    if (this.socket.readyState < WebSocket.CLOSING)
      this.socket.close(1000, "scheduled task finished");
  }

  private async initialize(): Promise<void> {
    await this.request("initialize", {
      clientInfo: {
        name: "codex-daemon-web-scheduler",
        title: "Codex Daemon Web Scheduler",
        version: "0.1.0",
      },
      capabilities: { experimentalApi: true },
    });
    this.notify("initialized", {});
  }

  private notify(method: string, params: JsonRecord): void {
    if (this.socket.readyState !== WebSocket.OPEN)
      throw new Error("The app-server connection is unavailable");
    this.socket.send(JSON.stringify({ method, params }));
  }

  private request<T>(
    method: string,
    params: JsonRecord,
    timeoutMs = 20_000,
  ): Promise<T> {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN)
      return Promise.reject(
        new AppServerRpcError(
          method,
          "The app-server connection is unavailable",
          false,
          false,
        ),
      );
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new AppServerRpcError(
            method,
            `Codex did not answer ${method} in time`,
            true,
            method === "turn/start",
          ),
        );
      }, timeoutMs);
      timeout.unref();
      const pending: PendingRequest = {
        method,
        sent: false,
        timeout,
        resolve: (value) => resolve(value as T),
        reject,
      };
      this.pending.set(id, pending);
      this.socket.send(JSON.stringify({ id, method, params }), (error) => {
        if (error) {
          this.pending.delete(id);
          clearTimeout(timeout);
          reject(
            new AppServerRpcError(
              method,
              "Could not send the app-server request",
              false,
              false,
            ),
          );
          return;
        }
        pending.sent = true;
      });
    });
  }

  private receive(text: string): void {
    let message: unknown;
    try {
      message = JSON.parse(text) as unknown;
    } catch {
      return this.closeWithError("The app-server returned invalid JSON");
    }
    const packet = asRecord(message);
    if (!packet)
      return this.closeWithError("The app-server returned an invalid message");
    if (typeof packet.method === "string") {
      if ("id" in packet) void this.handleServerRequest(packet);
      else
        this.handleNotification(packet.method, asRecord(packet.params) ?? {});
      return;
    }
    if (typeof packet.id !== "number") return;
    const pending = this.pending.get(packet.id);
    if (!pending) return;
    this.pending.delete(packet.id);
    clearTimeout(pending.timeout);
    if (isRecord(packet.error)) {
      const error = packet.error as RpcError;
      pending.reject(
        new AppServerRpcError(
          pending.method,
          typeof error.message === "string"
            ? error.message
            : "Codex rejected the request",
          pending.sent,
          false,
        ),
      );
      return;
    }
    pending.resolve(packet.result);
  }

  private async handleServerRequest(packet: JsonRecord): Promise<void> {
    const id = packet.id;
    const method = typeof packet.method === "string" ? packet.method : "";
    const params = asRecord(packet.params) ?? {};
    let result: JsonRecord | undefined;
    if (method === "item/commandExecution/requestApproval") {
      this.permissionDenied = true;
      result = { decision: "decline" };
    } else if (method === "item/execCommand/requestApproval") {
      this.permissionDenied = true;
      result = {
        decision: {
          denied: {
            rejection: "Scheduled runs cannot accept user approvals.",
          },
        },
      };
    } else if (method === "item/fileChange/requestApproval") {
      this.permissionDenied = true;
      result = { decision: "decline" };
    } else if (method === "item/tool/requestUserInput") {
      this.permissionDenied = true;
      const answers: JsonRecord = {};
      if (Array.isArray(params.questions)) {
        for (const question of params.questions) {
          const entry = asRecord(question);
          if (typeof entry?.id === "string")
            answers[entry.id] = { answers: [] };
        }
      }
      result = { answers };
    } else if (method === "mcpServer/elicitation/request") {
      this.permissionDenied = true;
      result = { action: "decline" };
    } else {
      this.permissionDenied = true;
      this.socket.send(
        JSON.stringify({
          id,
          error: {
            code: -32000,
            message: "Scheduled runs cannot accept permission requests.",
          },
        }),
      );
      return;
    }
    this.socket.send(JSON.stringify({ id, result }));
  }

  private handleNotification(method: string, params: JsonRecord): void {
    if (method !== "turn/completed") return;
    const turn = asRecord(params.turn);
    if (!turn || typeof turn.id !== "string") return;
    const completed = { ...turn, threadId: params.threadId };
    this.completedTurns.set(turn.id, completed);
    const waiter = this.completionWaiters.get(turn.id);
    if (waiter) {
      this.completionWaiters.delete(turn.id);
      waiter.resolve(completed);
    }
  }

  private waitForTurn(threadId: string, turnId: string): Promise<JsonRecord> {
    const completed = this.completedTurns.get(turnId);
    if (completed) return Promise.resolve(completed);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => {
          this.completionWaiters.delete(turnId);
          reject(
            new Error(
              "Codex did not complete the scheduled turn within 12 hours",
            ),
          );
        },
        12 * 60 * 60 * 1000,
      );
      timeout.unref();
      this.completionWaiters.set(turnId, {
        resolve: (turn) => {
          clearTimeout(timeout);
          if (typeof turn.threadId === "string" && turn.threadId !== threadId)
            reject(new Error("Codex completed a different conversation turn"));
          else resolve(turn);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
    });
  }

  private closeWithError(message: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(
        new AppServerRpcError(
          pending.method,
          message,
          pending.sent,
          pending.sent && pending.method === "turn/start",
        ),
      );
      this.pending.delete(id);
    }
    for (const waiter of this.completionWaiters.values())
      waiter.reject(new Error(message));
    this.completionWaiters.clear();
  }
}

export class ActiveThreadError extends Error {
  constructor() {
    super("The selected conversation is still active");
    this.name = "ActiveThreadError";
  }
}

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assistantText(items: unknown): string {
  if (!Array.isArray(items)) return "";
  const messages: string[] = [];
  for (const item of items) {
    const entry = asRecord(item);
    if (entry?.type === "agentMessage" && typeof entry.text === "string")
      messages.push(entry.text);
  }
  return messages.join("\n").trim().slice(0, 4000);
}
