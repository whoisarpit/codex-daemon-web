import type { ScheduledTask, ThreadSummary } from "./types";
import { agentParentId } from "./project-sidebar";

export type ThreadIndicator = "idle" | "working" | "decision" | "waiting" | "error";
export type ThreadIndicatorInfo = { kind: ThreadIndicator; label: string };

/** A paused or archived task is not an active schedule. */
export function scheduledThreadIds(tasks: ScheduledTask[]): Set<string> {
  const bound = new Set<string>();
  for (const task of tasks) {
    if (task.status !== "active") continue;
    if (task.sourceThreadId) bound.add(task.sourceThreadId);
    // A new-chat recurring schedule can reuse an existing run's thread.
    if (task.mode === "newChat") {
      for (const run of task.runs) if (run.threadId) bound.add(run.threadId);
    }
  }
  return bound;
}

export function activeSubagentParents(agents: ThreadSummary[]): Set<string> {
  const active = new Set(agents.filter((agent) => agent.status?.type === "active").map((agent) => agent.id));
  const parents = new Set<string>();
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  for (const agent of agents) {
    if (!active.has(agent.id)) continue;
    const seen = new Set([agent.id]);
    let parentId = agentParentId(agent);
    while (parentId && !seen.has(parentId)) {
      seen.add(parentId);
      parents.add(parentId);
      const parent = byId.get(parentId);
      parentId = parent ? agentParentId(parent) : null;
    }
  }
  return parents;
}

export function threadIndicator(
  thread: ThreadSummary,
  options: { pendingDecision?: boolean; activeChild?: boolean; scheduled?: boolean; failedTurn?: boolean } = {},
): ThreadIndicatorInfo {
  if (thread.status?.type === "systemError" || options.failedTurn)
    return { kind: "error", label: "Codex error / failed turn" };
  const flags = thread.status?.type === "active" ? thread.status.activeFlags || [] : [];
  const needsDecision = options.pendingDecision || flags.some((flag) =>
    /approval|input|user.?response|elicitation|decision|permission/i.test(flag),
  );
  if (needsDecision) return { kind: "decision", label: "Needs your decision" };
  if (flags.some((flag) => /sub.?agent|child.?agent|await.?agent|waiting.?agent/i.test(flag)))
    return { kind: "waiting", label: "Waiting for subagent" };
  // If a child is active, indicate parent coordination; this is an inference,
  // not a claim that the parent process has stopped all independent work.
  if (options.activeChild) return { kind: "waiting", label: "Subagent working (parent coordinating)" };
  if (thread.status?.type === "active") return { kind: "working", label: "Working" };
  if (options.scheduled) return { kind: "waiting", label: "Idle · bound to active scheduled task" };
  return { kind: "idle", label: "Idle" };
}
