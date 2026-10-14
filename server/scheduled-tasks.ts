import { randomBytes, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { Temporal } from "@js-temporal/polyfill";

export type TaskMode = "sameChat" | "newChat";
export type TaskWeekday = "MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU";
export type TaskSchedule =
  | { type: "interval"; minutes: number }
  | { type: "daily"; time: string }
  | { type: "weekly"; time: string; weekdays: TaskWeekday[] };
export type TaskStatus = "active" | "paused" | "archived";
export type TaskRunStatus =
  | "starting"
  | "running"
  | "completed"
  | "failed"
  | "deferred"
  | "skipped"
  | "interrupted"
  | "blocked";

export type ScheduledTaskRun = {
  id: string;
  scheduledAt: number;
  startedAt: number | null;
  completedAt: number | null;
  status: TaskRunStatus;
  threadId: string | null;
  summary: string | null;
  error: string | null;
  manual: boolean;
};

export type ScheduledTask = {
  id: string;
  name: string;
  prompt: string;
  mode: TaskMode;
  sourceThreadId: string | null;
  cwd: string | null;
  timezone: string;
  schedule: TaskSchedule;
  model: string | null;
  reasoningEffort: string | null;
  status: TaskStatus;
  createdAt: number;
  updatedAt: number;
  nextRunAt: number | null;
  pendingManualRun: boolean;
  manualRunNotBefore: number | null;
  consecutiveFailures: number;
  pauseReason: string | null;
  runs: ScheduledTaskRun[];
};

export type ScheduledTaskInput = {
  name: unknown;
  prompt: unknown;
  mode: unknown;
  threadId?: unknown;
  cwd?: unknown;
  timezone?: unknown;
  schedule: unknown;
  model?: unknown;
  reasoningEffort?: unknown;
};

type StoreData = { version: 1; tasks: ScheduledTask[] };

const weekdays: TaskWeekday[] = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
const weekdayNumbers: Record<TaskWeekday, number> = {
  MO: 1,
  TU: 2,
  WE: 3,
  TH: 4,
  FR: 5,
  SA: 6,
  SU: 7,
};
const defaultTimezone = "Asia/Singapore";

export class TaskValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskValidationError";
  }
}

export class TaskNotFoundError extends Error {
  constructor() {
    super("Scheduled task not found");
    this.name = "TaskNotFoundError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fail(message: string): never {
  throw new TaskValidationError(message);
}

function normalizeSchedule(value: unknown): TaskSchedule {
  if (!isRecord(value) || typeof value.type !== "string")
    return fail("A recurrence schedule is required");
  if (value.type === "interval") {
    if (
      typeof value.minutes !== "number" ||
      !Number.isInteger(value.minutes) ||
      value.minutes < 1 ||
      value.minutes > 10080
    ) {
      return fail("Interval must be between 1 minute and 7 days");
    }
    return { type: "interval", minutes: value.minutes };
  }
  if (value.type === "daily" || value.type === "weekly") {
    if (
      typeof value.time !== "string" ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(value.time)
    )
      return fail("Time must use 24-hour HH:mm format");
    if (value.type === "daily") return { type: "daily", time: value.time };
    if (
      !Array.isArray(value.weekdays) ||
      value.weekdays.length < 1 ||
      value.weekdays.some(
        (day) =>
          typeof day !== "string" || !weekdays.includes(day as TaskWeekday),
      )
    ) {
      return fail("Choose at least one valid weekday");
    }
    return {
      type: "weekly",
      time: value.time,
      weekdays: [...new Set(value.weekdays as TaskWeekday[])].sort(
        (a, b) => weekdayNumbers[a] - weekdayNumbers[b],
      ),
    };
  }
  return fail("Unsupported recurrence schedule");
}

function timezone(value: unknown): string {
  const result = typeof value === "string" && value ? value : defaultTimezone;
  try {
    Temporal.Now.plainDateISO(result);
  } catch {
    return fail("Timezone must be a valid IANA timezone");
  }
  return result;
}

function optionalString(
  value: unknown,
  label: string,
  maxLength: number,
): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > maxLength)
    return fail(`${label} is invalid`);
  return value;
}

function normalizeInput(value: ScheduledTaskInput) {
  const name = typeof value.name === "string" ? value.name.trim() : "";
  const prompt = typeof value.prompt === "string" ? value.prompt.trim() : "";
  if (!name || name.length > 120)
    return fail("Task name must be 1–120 characters");
  if (!prompt || prompt.length > 12000)
    return fail("Task instructions must be 1–12,000 characters");
  if (value.mode !== "sameChat" && value.mode !== "newChat")
    return fail("Choose same chat or new chat for each run");
  const mode: TaskMode = value.mode;
  const threadId = optionalString(value.threadId, "Thread id", 256);
  if (mode === "sameChat" && !threadId)
    return fail("A conversation is required for same-chat runs");
  const rawCwd = optionalString(value.cwd, "Working directory", 2048);
  if (rawCwd && !isAbsolute(rawCwd))
    return fail("Working directory must be an absolute path");
  const cwd = rawCwd ? resolve(rawCwd) : null;
  if (mode === "newChat" && !cwd)
    return fail("A working directory is required for new-chat runs");
  const model = optionalString(value.model, "Model", 128);
  const reasoningEffort = optionalString(
    value.reasoningEffort,
    "Reasoning effort",
    32,
  );
  return {
    name,
    prompt,
    mode,
    sourceThreadId: threadId,
    cwd,
    timezone: timezone(value.timezone),
    schedule: normalizeSchedule(value.schedule),
    model,
    reasoningEffort,
  };
}

function localTime(
  date: Temporal.PlainDate,
  time: string,
  zone: string,
): number {
  const [hour, minute] = time.split(":").map(Number);
  return Number(
    date
      .toPlainDateTime({ hour, minute })
      .toZonedDateTime(zone, { disambiguation: "compatible" })
      .epochMilliseconds,
  );
}

export function nextTaskOccurrence(
  schedule: TaskSchedule,
  zone: string,
  after: number,
  anchor: number,
): number {
  if (schedule.type === "interval") {
    const step = schedule.minutes * 60_000;
    return anchor + (Math.floor((after - anchor) / step) + 1) * step;
  }
  const afterZoned =
    Temporal.Instant.fromEpochMilliseconds(after).toZonedDateTimeISO(zone);
  const currentDate = afterZoned.toPlainDate();
  for (let offset = 0; offset <= 7; offset += 1) {
    const date = currentDate.add({ days: offset });
    if (
      schedule.type === "weekly" &&
      !schedule.weekdays.some((day) => weekdayNumbers[day] === date.dayOfWeek)
    ) {
      continue;
    }
    const candidate = localTime(date, schedule.time, zone);
    if (candidate > after) return candidate;
  }
  throw new Error("Could not calculate the next scheduled task run");
}

async function prepareStateDirectory(filePath: string): Promise<string> {
  const directory = dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const details = await lstat(directory);
  if (!details.isDirectory())
    throw new Error("Task state directory must be a real directory");
  if (typeof process.getuid === "function" && details.uid !== process.getuid())
    throw new Error("Task state directory must be owned by the current user");
  if ((details.mode & 0o077) !== 0) await chmod(directory, 0o700);
  return directory;
}

function parseStore(value: unknown): StoreData {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.tasks))
    throw new Error("Scheduled task state has an unsupported format");
  return { version: 1, tasks: value.tasks as ScheduledTask[] };
}

function canClaimTask(
  task: ScheduledTask,
  now: number,
  excludedTaskIds: ReadonlySet<string>,
): boolean {
  return (
    !excludedTaskIds.has(task.id) &&
    task.status !== "archived" &&
    ((task.pendingManualRun &&
      (task.manualRunNotBefore === null || task.manualRunNotBefore <= now)) ||
      (task.status === "active" &&
        task.nextRunAt !== null &&
        task.nextRunAt <= now))
  );
}

export class ScheduledTaskStore {
  private data: StoreData = { version: 1, tasks: [] };
  private initialized: Promise<void> | undefined;
  private queue = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly now: () => number = Date.now,
  ) {}

  initialize(): Promise<void> {
    this.initialized ??= this.load();
    return this.initialized;
  }

  private async load(): Promise<void> {
    await prepareStateDirectory(this.filePath);
    try {
      const details = await lstat(this.filePath);
      if (!details.isFile()) throw new Error("Task state path must be a file");
      if (
        typeof process.getuid === "function" &&
        details.uid !== process.getuid()
      )
        throw new Error("Task state file must be owned by the current user");
      if ((details.mode & 0o077) !== 0) await chmod(this.filePath, 0o600);
      const fileDetails = await stat(this.filePath);
      if (fileDetails.size > 100 * 1024 * 1024)
        throw new Error("Scheduled task state exceeds 100 MB");
      this.data = parseStore(
        JSON.parse(await readFile(this.filePath, "utf8")) as unknown,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.write(this.data);
    }
  }

  private async write(data: StoreData): Promise<void> {
    const directory = await prepareStateDirectory(this.filePath);
    const temporaryPath = `${directory}/.scheduled-tasks-${process.pid}-${randomBytes(8).toString("hex")}.tmp`;
    try {
      const file = await open(temporaryPath, "wx", 0o600);
      try {
        await file.writeFile(`${JSON.stringify(data)}\n`, "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporaryPath, this.filePath);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  private async mutate<T>(
    operation: () => T | Promise<T>,
    shouldWrite: (value: T) => boolean = () => true,
  ): Promise<T> {
    await this.initialize();
    const result = this.queue.then(async () => {
      const original = this.data;
      const draft = structuredClone(original);
      this.data = draft;
      try {
        const value = await operation();
        if (!shouldWrite(value)) {
          this.data = original;
          return value;
        }
        await this.write(draft);
        return value;
      } catch (error) {
        this.data = original;
        throw error;
      }
    });
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async list(includeArchived = false): Promise<ScheduledTask[]> {
    await this.initialize();
    await this.queue;
    return this.data.tasks
      .filter((task) => includeArchived || task.status !== "archived")
      .map((task) => structuredClone(task));
  }

  async get(id: string): Promise<ScheduledTask> {
    await this.initialize();
    await this.queue;
    const task = this.data.tasks.find((entry) => entry.id === id);
    if (!task) throw new TaskNotFoundError();
    return structuredClone(task);
  }

  async create(input: ScheduledTaskInput): Promise<ScheduledTask> {
    const normalized = normalizeInput(input);
    const createdAt = this.now();
    const task: ScheduledTask = {
      ...normalized,
      id: randomUUID(),
      status: "active",
      createdAt,
      updatedAt: createdAt,
      nextRunAt: nextTaskOccurrence(
        normalized.schedule,
        normalized.timezone,
        createdAt,
        createdAt,
      ),
      pendingManualRun: false,
      manualRunNotBefore: null,
      consecutiveFailures: 0,
      pauseReason: null,
      runs: [],
    };
    return this.mutate(() => {
      this.data.tasks.push(task);
      return structuredClone(task);
    });
  }

  async update(id: string, input: ScheduledTaskInput): Promise<ScheduledTask> {
    const normalized = normalizeInput(input);
    return this.mutate(() => {
      const task = this.data.tasks.find((entry) => entry.id === id);
      if (!task) throw new TaskNotFoundError();
      Object.assign(task, normalized, {
        updatedAt: this.now(),
        nextRunAt:
          task.status === "active"
            ? nextTaskOccurrence(
                normalized.schedule,
                normalized.timezone,
                this.now(),
                task.createdAt,
              )
            : null,
      });
      return structuredClone(task);
    });
  }

  async setStatus(
    id: string,
    status: "active" | "paused" | "archived",
  ): Promise<ScheduledTask> {
    return this.mutate(() => {
      const task = this.data.tasks.find((entry) => entry.id === id);
      if (!task) throw new TaskNotFoundError();
      task.status = status;
      task.updatedAt = this.now();
      if (status !== "active") {
        task.pendingManualRun = false;
        task.manualRunNotBefore = null;
      }
      if (status === "active") {
        task.pauseReason = null;
        task.consecutiveFailures = 0;
        task.nextRunAt = nextTaskOccurrence(
          task.schedule,
          task.timezone,
          this.now(),
          task.createdAt,
        );
      } else {
        task.nextRunAt = null;
      }
      return structuredClone(task);
    });
  }

  async pauseForReason(id: string, reason: string): Promise<ScheduledTask> {
    return this.mutate(() => {
      const task = this.data.tasks.find((entry) => entry.id === id);
      if (!task) throw new TaskNotFoundError();
      task.status = "paused";
      task.nextRunAt = null;
      task.pendingManualRun = false;
      task.manualRunNotBefore = null;
      task.pauseReason = reason;
      task.updatedAt = this.now();
      return structuredClone(task);
    });
  }

  async requestRunNow(id: string): Promise<ScheduledTask> {
    return this.mutate(() => {
      const task = this.data.tasks.find((entry) => entry.id === id);
      if (!task) throw new TaskNotFoundError();
      if (task.status === "archived")
        return fail("Archived tasks cannot be run");
      task.pendingManualRun = true;
      task.manualRunNotBefore = null;
      task.updatedAt = this.now();
      return structuredClone(task);
    });
  }

  async claimDue(
    now = this.now(),
    excludedTaskIds: ReadonlySet<string> = new Set(),
  ): Promise<{ task: ScheduledTask; run: ScheduledTaskRun } | null> {
    await this.initialize();
    await this.queue;
    if (
      !this.data.tasks.some((task) => canClaimTask(task, now, excludedTaskIds))
    )
      return null;
    return this.mutate(
      () => {
        const task = this.data.tasks
          .filter((entry) => canClaimTask(entry, now, excludedTaskIds))
          .sort((a, b) => {
            const left =
              a.pendingManualRun &&
              (a.manualRunNotBefore === null || a.manualRunNotBefore <= now)
                ? now
                : (a.nextRunAt ?? Infinity);
            const right =
              b.pendingManualRun &&
              (b.manualRunNotBefore === null || b.manualRunNotBefore <= now)
                ? now
                : (b.nextRunAt ?? Infinity);
            return left - right;
          })[0];
        if (!task) return null;
        const manual =
          task.pendingManualRun &&
          (task.manualRunNotBefore === null || task.manualRunNotBefore <= now);
        const scheduledAt = manual ? now : task.nextRunAt!;
        if (manual) {
          task.pendingManualRun = false;
          task.manualRunNotBefore = null;
        }
        if (!manual) {
          task.nextRunAt = nextTaskOccurrence(
            task.schedule,
            task.timezone,
            Math.max(now, scheduledAt),
            task.createdAt,
          );
        }
        const run: ScheduledTaskRun = {
          id: randomUUID(),
          scheduledAt,
          startedAt: now,
          completedAt: null,
          status: "starting",
          threadId: task.mode === "sameChat" ? task.sourceThreadId : null,
          summary: null,
          error: null,
          manual,
        };
        task.runs.push(run);
        task.updatedAt = now;
        return { task: structuredClone(task), run: structuredClone(run) };
      },
      (claimed) => claimed !== null,
    );
  }

  async updateRun(
    taskId: string,
    runId: string,
    changes: Partial<
      Pick<
        ScheduledTaskRun,
        "status" | "threadId" | "summary" | "error" | "completedAt"
      >
    >,
  ): Promise<ScheduledTask> {
    return this.mutate(() => {
      const task = this.data.tasks.find((entry) => entry.id === taskId);
      const run = task?.runs.find((entry) => entry.id === runId);
      if (!task || !run) throw new TaskNotFoundError();
      Object.assign(run, changes);
      task.updatedAt = this.now();
      if (changes.status === "completed") {
        task.consecutiveFailures = 0;
        task.pauseReason = null;
      } else if (
        changes.status === "failed" ||
        changes.status === "blocked" ||
        changes.status === "interrupted"
      ) {
        task.consecutiveFailures += 1;
        if (task.consecutiveFailures >= 3) {
          task.status = "paused";
          task.nextRunAt = null;
          task.pauseReason = "Paused after three consecutive failed runs";
        }
      }
      return structuredClone(task);
    });
  }

  async deferRun(
    taskId: string,
    runId: string,
    retryAt: number,
  ): Promise<void> {
    await this.mutate(() => {
      const task = this.data.tasks.find((entry) => entry.id === taskId);
      const run = task?.runs.find((entry) => entry.id === runId);
      if (!task || !run) throw new TaskNotFoundError();
      run.status = "deferred";
      run.completedAt = this.now();
      run.error =
        "The selected conversation is still active. This run is deferred.";
      if (run.manual) {
        task.pendingManualRun = true;
        task.manualRunNotBefore = retryAt;
      } else if (task.status === "active") {
        task.nextRunAt = retryAt;
      }
      task.updatedAt = this.now();
    });
  }

  async skipDue(taskId: string, now = this.now()): Promise<void> {
    let changed = false;
    await this.mutate(
      () => {
        const task = this.data.tasks.find((entry) => entry.id === taskId);
        if (
          !task ||
          task.status !== "active" ||
          task.nextRunAt === null ||
          task.nextRunAt > now
        )
          return;
        task.runs.push({
          id: randomUUID(),
          scheduledAt: task.nextRunAt,
          startedAt: null,
          completedAt: now,
          status: "skipped",
          threadId: task.mode === "sameChat" ? task.sourceThreadId : null,
          summary: null,
          error:
            "This occurrence was skipped because another run was still active.",
          manual: false,
        });
        task.nextRunAt = nextTaskOccurrence(
          task.schedule,
          task.timezone,
          now,
          task.createdAt,
        );
        task.updatedAt = now;
        changed = true;
      },
      () => changed,
    );
  }

  async recover(now = this.now()): Promise<void> {
    let changed = false;
    await this.mutate(
      () => {
        for (const task of this.data.tasks) {
          for (const run of task.runs) {
            if (run.status === "starting" || run.status === "running") {
              changed = true;
              run.status = "interrupted";
              run.completedAt = now;
              run.error =
                "The scheduler stopped before this run completed; it was not restarted to avoid duplicate work.";
              task.consecutiveFailures += 1;
              task.status = "paused";
              task.nextRunAt = null;
              task.pendingManualRun = false;
              task.manualRunNotBefore = null;
              task.pauseReason =
                "Paused because the previous run may have started before the scheduler stopped";
            }
          }
          if (
            task.status === "active" &&
            task.nextRunAt !== null &&
            task.nextRunAt <= now
          ) {
            changed = true;
            task.runs.push({
              id: randomUUID(),
              scheduledAt: task.nextRunAt,
              startedAt: null,
              completedAt: now,
              status: "skipped",
              threadId: task.mode === "sameChat" ? task.sourceThreadId : null,
              summary: null,
              error:
                "This occurrence was skipped because the scheduler was offline.",
              manual: false,
            });
            task.nextRunAt = nextTaskOccurrence(
              task.schedule,
              task.timezone,
              now,
              task.createdAt,
            );
          }
          if (task.consecutiveFailures >= 3 && task.status === "active") {
            changed = true;
            task.status = "paused";
            task.nextRunAt = null;
            task.pauseReason = "Paused after three consecutive failed runs";
          }
        }
      },
      () => changed,
    );
  }
}
