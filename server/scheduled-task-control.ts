import { createConnection } from "node:net";
import { createServer, type Server } from "node:http";
import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { config } from "./config.js";
import { ScheduledTaskScheduler } from "./scheduled-task-scheduler.js";
import {
  ScheduledTaskStore,
  TaskNotFoundError,
  TaskValidationError,
  type ScheduledTaskInput,
} from "./scheduled-tasks.js";

type ControlRequest = {
  operation?: unknown;
  id?: unknown;
  includeArchived?: unknown;
  task?: ScheduledTaskInput;
};

const maxRequestBytes = 64 * 1024;

export async function startScheduledTaskControlSocket(
  store: ScheduledTaskStore,
  scheduler: ScheduledTaskScheduler,
): Promise<Server> {
  const directory = dirname(config.scheduledTasksSocketPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryInfo = await lstat(directory);
  if (!directoryInfo.isDirectory())
    throw new Error("Task socket directory must be a real directory");
  if (
    typeof process.getuid === "function" &&
    directoryInfo.uid !== process.getuid()
  )
    throw new Error("Task socket directory must be owned by the service user");
  if ((directoryInfo.mode & 0o077) !== 0) await chmod(directory, 0o700);
  await removeStaleSocket(config.scheduledTasksSocketPath);

  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    if (request.method !== "POST" || request.url !== "/tasks") {
      response.writeHead(404).end(JSON.stringify({ error: "Route not found" }));
      return;
    }
    void readRequest(request)
      .then((body) => handleControlRequest(store, scheduler, body))
      .then((result) => response.writeHead(200).end(JSON.stringify({ result })))
      .catch((error: unknown) => {
        const status =
          error instanceof TaskValidationError
            ? 400
            : error instanceof TaskNotFoundError
              ? 404
              : 500;
        const message =
          error instanceof Error ? error.message : "Task operation failed";
        response.writeHead(status).end(JSON.stringify({ error: message }));
      });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.scheduledTasksSocketPath, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  await chmod(config.scheduledTasksSocketPath, 0o600);
  return server;
}

export async function stopScheduledTaskControlSocket(
  server: Server,
): Promise<void> {
  const socketPath = config.scheduledTasksSocketPath;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await unlink(socketPath).catch(() => undefined);
}

async function removeStaleSocket(path: string): Promise<void> {
  try {
    const details = await lstat(path);
    if (!details.isSocket())
      throw new Error("Task socket path exists and is not a socket");
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection(path);
      socket.once("connect", () => {
        socket.destroy();
        reject(new Error("Another task control server is already running"));
      });
      socket.once("error", async () => {
        await unlink(path).then(resolve, reject);
      });
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function readRequest(
  request: NodeJS.ReadableStream,
): Promise<ControlRequest> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > maxRequestBytes)
      throw new TaskValidationError("Task request is too large");
    chunks.push(buffer);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (value === null || typeof value !== "object" || Array.isArray(value))
      throw new Error();
    return value as ControlRequest;
  } catch {
    throw new TaskValidationError("Task request must be a JSON object");
  }
}

async function handleControlRequest(
  store: ScheduledTaskStore,
  scheduler: ScheduledTaskScheduler,
  request: ControlRequest,
): Promise<unknown> {
  const id = typeof request.id === "string" ? request.id : "";
  switch (request.operation) {
    case "list":
      return store.list(request.includeArchived === true);
    case "get":
      return store.get(requiredId(id));
    case "create": {
      if (!request.task)
        throw new TaskValidationError("Task details are required");
      const task = await store.create(request.task);
      void scheduler.wake();
      return task;
    }
    case "update": {
      if (!request.task)
        throw new TaskValidationError("Task details are required");
      const task = await store.update(requiredId(id), request.task);
      void scheduler.wake();
      return task;
    }
    case "pause":
      return store.setStatus(requiredId(id), "paused");
    case "resume": {
      const task = await store.setStatus(requiredId(id), "active");
      void scheduler.wake();
      return task;
    }
    case "archive":
      return store.setStatus(requiredId(id), "archived");
    case "restore": {
      const task = await store.setStatus(requiredId(id), "active");
      void scheduler.wake();
      return task;
    }
    case "runNow": {
      const task = await store.requestRunNow(requiredId(id));
      void scheduler.wake();
      return task;
    }
    default:
      throw new TaskValidationError("Unsupported task operation");
  }
}

function requiredId(id: string): string {
  if (!id || id.length > 256)
    throw new TaskValidationError("A task id is required");
  return id;
}
