import {
  AppServerRpc,
  AppServerRpcError,
  ActiveThreadError,
  AmbiguousTurnError,
} from "./app-server-rpc.js";
import type { ScheduledTask, ScheduledTaskRun } from "./scheduled-tasks.js";
import { ScheduledTaskStore } from "./scheduled-tasks.js";

const tickMs = 10_000;
const lateRunGraceMs = 60_000;
const activeChatRetryMs = 60_000;
const maxConcurrentRuns = 4;

export class ScheduledTaskScheduler {
  private timer: NodeJS.Timeout | undefined;
  private ticking: Promise<void> | undefined;
  private wakePending = false;
  private readonly activeRuns = new Map<string, Promise<void>>();
  private stopped = true;

  constructor(
    private readonly store: ScheduledTaskStore,
    private readonly now: () => number = Date.now,
    private readonly connect: typeof AppServerRpc.connect = AppServerRpc.connect,
  ) {}

  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    await this.store.initialize();
    await this.store.recover(this.now());
    this.timer = setInterval(() => void this.wake(), tickMs);
    this.timer.unref();
    void this.wake();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  wake(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.wakePending = true;
    if (!this.ticking) {
      this.ticking = this.tick()
        .catch((error: unknown) => {
          process.stderr.write(
            `Scheduled task dispatch failed: ${safeError(error)}\n`,
          );
        })
        .finally(() => {
          this.ticking = undefined;
          if (this.wakePending && !this.stopped) void this.wake();
        });
    }
    return Promise.resolve();
  }

  private async tick(): Promise<void> {
    this.wakePending = false;
    while (!this.stopped) {
      const now = this.now();
      const tasks = await this.store.list(true);
      const dueWhileRunning = tasks.find(
        (task) =>
          this.activeRuns.has(task.id) &&
          task.status === "active" &&
          task.nextRunAt !== null &&
          task.nextRunAt <= now,
      );
      if (dueWhileRunning) {
        await this.store.skipDue(dueWhileRunning.id, now);
        continue;
      }
      if (this.activeRuns.size >= maxConcurrentRuns) return;
      const overdue = tasks.find(
        (task) =>
          !this.activeRuns.has(task.id) &&
          task.status === "active" &&
          !task.pendingManualRun &&
          task.nextRunAt !== null &&
          task.nextRunAt < now - lateRunGraceMs,
      );
      if (overdue) {
        await this.store.skipDue(overdue.id, now);
        continue;
      }
      const claimed = await this.store.claimDue(
        now,
        new Set(this.activeRuns.keys()),
      );
      if (!claimed) return;
      const execution = this.execute(claimed.task, claimed.run)
        .catch((error: unknown) => {
          process.stderr.write(
            `Scheduled task run failed unexpectedly: ${safeError(error)}\n`,
          );
        })
        .finally(() => {
          this.activeRuns.delete(claimed.task.id);
          void this.wake();
        });
      this.activeRuns.set(claimed.task.id, execution);
    }
  }

  private async execute(
    task: ScheduledTask,
    run: ScheduledTaskRun,
  ): Promise<void> {
    let rpc: AppServerRpc | undefined;
    try {
      rpc = await this.connect(async (threadId) => {
        await this.store.updateRun(task.id, run.id, {
          threadId,
          status: "running",
        });
      });
      const result = await rpc.startTaskTurn(task);
      await this.store.updateRun(task.id, run.id, {
        threadId: result.threadId,
        status: "completed",
        completedAt: this.now(),
        summary: result.summary || "Run completed.",
        error: null,
      });
    } catch (error) {
      if (error instanceof ActiveThreadError) {
        await this.store.deferRun(
          task.id,
          run.id,
          this.now() + activeChatRetryMs,
        );
        return;
      }
      if (
        error instanceof AmbiguousTurnError ||
        (error instanceof AppServerRpcError && error.ambiguous)
      ) {
        const message = safeError(error);
        await this.store.updateRun(task.id, run.id, {
          status: "interrupted",
          completedAt: this.now(),
          error: `${message}. This run was not retried because it may already have started.`,
        });
        await this.store.pauseForReason(
          task.id,
          "Paused because Codex may have started a run without confirming its outcome.",
        );
        return;
      }
      const message = safeError(error);
      const blocked = message.includes("requested user approval");
      await this.store.updateRun(task.id, run.id, {
        status: blocked ? "blocked" : "failed",
        completedAt: this.now(),
        error: message,
      });
      if (blocked)
        await this.store.pauseForReason(
          task.id,
          "Paused because this run needed an approval or user answer.",
        );
    } finally {
      rpc?.close();
    }
  }
}

function safeError(error: unknown): string {
  const message =
    error instanceof Error ? error.message : "Scheduled run failed";
  return message.replace(/[\r\n\t]+/g, " ").slice(0, 1000);
}
