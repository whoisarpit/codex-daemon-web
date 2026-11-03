import type { ThreadSummary } from "./types";

export type ProjectSort = "recent" | "name";
export type ProjectPreferences = {
  collapsed: Record<string, boolean>;
  sort: ProjectSort;
  view: SidebarView;
};
export const projectPreferencesKey = "codex-web.project-sidebar.v1";

export function readProjectPreferences(storage: Pick<Storage, "getItem">): ProjectPreferences {
  try {
    const value = JSON.parse(storage.getItem(projectPreferencesKey) || "null");
    const collapsed: Record<string, boolean> = Object.create(null);
    if (value?.collapsed && typeof value.collapsed === "object" && !Array.isArray(value.collapsed)) {
      for (const [key, state] of Object.entries(value.collapsed)) {
        if (typeof state === "boolean") collapsed[key] = state;
      }
    }
    return { collapsed, sort: value?.sort === "name" ? "name" : "recent", view: value?.view === "status" ? "status" : "projects" };
  } catch {
    return { collapsed: {}, sort: "recent", view: "projects" };
  }
}

function activity(thread: ThreadSummary, archived: boolean): number {
  const value = (archived ? thread.updatedAt : thread.recencyAt) ?? thread.updatedAt ?? thread.createdAt;
  return Number.isFinite(value) && value > 0 ? (value < 1e12 ? value * 1000 : value) : 0;
}

// Subagent threads are excluded from the default thread/list sources. Their
// parent relationship is stored in source.subAgent.thread_spawn on this daemon.
export const subagentSourceKinds = [
  "subAgent", "subAgentReview", "subAgentCompact", "subAgentThreadSpawn", "subAgentOther",
];

export function agentParentId(thread: ThreadSummary): string | null {
  if (thread.parentThreadId) return thread.parentThreadId;
  const source = thread.source;
  if (typeof source === "object" && source?.subAgent?.thread_spawn?.parent_thread_id)
    return source.subAgent.thread_spawn.parent_thread_id;
  return null;
}

export function agentDisplayName(thread: ThreadSummary): string | null {
  if (thread.agentNickname) return thread.agentNickname;
  const source = thread.source;
  return typeof source === "object" ? source?.subAgent?.thread_spawn?.agent_nickname || null : null;
}

export type ThreadTreeRow = {
  thread: ThreadSummary;
  depth: number;
  childCount: number;
  expanded: boolean;
};

export function agentAncestorIds(agents: ThreadSummary[], query: string): Set<string> {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const ancestors = new Set<string>();
  for (const agent of agents) {
    if (!`${agent.name || ""} ${agent.preview} ${agent.cwd} ${agentDisplayName(agent) || ""}`.toLowerCase().includes(query)) continue;
    let parent = agentParentId(agent);
    const seen = new Set([agent.id]);
    while (parent && !seen.has(parent)) {
      ancestors.add(parent);
      seen.add(parent);
      parent = byId.has(parent) ? agentParentId(byId.get(parent)!) : null;
    }
  }
  return ancestors;
}

export function buildAgentTreeRows(
  roots: ThreadSummary[], agents: ThreadSummary[], collapsed: Record<string, boolean>,
  archived: boolean, query = "",
): ThreadTreeRow[] {
  const byParent = new Map<string, ThreadSummary[]>();
  const rootIds = new Set(roots.map((thread) => thread.id));
  const agentIds = new Set(agents.map((agent) => agent.id));
  for (const agent of agents) {
    const parent = agentParentId(agent);
    if (!parent || parent === agent.id || (!rootIds.has(parent) && !agentIds.has(parent))) continue;
    const children = byParent.get(parent) || [];
    children.push(agent);
    byParent.set(parent, children);
  }
  for (const children of byParent.values()) {
    children.sort((a,b) => activity(b,archived)-activity(a,archived) || a.id.localeCompare(b.id));
  }
  const matches = (thread: ThreadSummary) =>
    `${thread.name || ""} ${thread.preview} ${thread.cwd} ${agentDisplayName(thread) || ""}`.toLowerCase().includes(query);
  const ancestors = query ? agentAncestorIds(agents, query) : new Set<string>();
  const rows: ThreadTreeRow[] = [];
  const visit = (thread: ThreadSummary, depth: number, inheritedMatch: boolean, path: Set<string>) => {
    if (path.has(thread.id)) return;
    const ownMatch = Boolean(query && matches(thread));
    if (query && !inheritedMatch && !ownMatch && !ancestors.has(thread.id)) return;
    const children = byParent.get(thread.id) || [];
    const expanded = Boolean(query) || !collapsed[thread.id];
    rows.push({thread, depth, childCount:children.length, expanded});
    if (!expanded) return;
    const nextPath = new Set(path); nextPath.add(thread.id);
    for (const child of children) visit(child, depth+1, inheritedMatch || ownMatch, nextPath);
  };
  for (const root of roots) visit(root,0,false,new Set());
  return rows;
}

/** Canonical Codex project memberships. No cwd-based inferred groups. */
export type CodexProject = {
  id: string;
  name: string;
  roots: Array<{path:string}>;
  recencyAt: number | null;
};
export type ProjectCreateParams = {
  name: string;
  roots: Array<{path:string}>;
  idempotencyKey: string;
};
export function buildProjectCreateParams(name:string, root:string, idempotencyKey:string):ProjectCreateParams {
  const normalizedName=name.trim();
  const normalizedRoot=root.trim();
  if(!normalizedName)throw new Error("Project name is required.");
  if(!normalizedRoot.startsWith("/") || normalizedRoot.includes("\0"))
    throw new Error("Project root must be an absolute path on the Codex host.");
  if(!idempotencyKey)throw new Error("Project creation idempotency key is missing.");
  return {name:normalizedName,roots:[{path:normalizedRoot}],idempotencyKey};
}
export type SidebarView = "projects" | "status";
export type SidebarThreadGroup = {
  cwd: string; name: string; path: string; projectId: string | null;
  kind: "project" | "unassigned" | "status";
  threads: ThreadSummary[]; activity: number;
};
export const statusGroupOrder = ["error", "decision", "working", "waiting", "idle"] as const;
export const statusGroupLabels: Record<string,string> = {
  error: "Error", decision: "Needs decision", working: "Working",
  waiting: "Waiting / Scheduled", idle: "Idle",
};
export function groupSidebarThreads(
  threads: ThreadSummary[],
  projects: CodexProject[],
  sort: ProjectSort,
  archived: boolean,
  view: SidebarView,
  getStatus: (thread: ThreadSummary) => string,
): SidebarThreadGroup[] {
  const groups = new Map<string, SidebarThreadGroup>();
  if (view === "status") {
    for (const kind of statusGroupOrder) {
      groups.set("status:"+kind,{
        cwd:"status:"+kind,name:statusGroupLabels[kind],path:"Parent conversations and their child agents",
        projectId:null,kind:"status",threads:[],activity:0,
      });
    }
  } else {
    for (const project of projects) {
      groups.set("project:"+project.id,{
        cwd:"project:"+project.id,name:project.name,path:project.roots.map(x=>x.path).join(" · ") || "No root",
        projectId:project.id,kind:"project",threads:[],activity:0,
      });
    }
  }
  for (const thread of threads) {
    let key:string;
    if (view === "status") key="status:"+getStatus(thread);
    else if (thread.projectId && groups.has("project:"+thread.projectId))
      key="project:"+thread.projectId;
    else {
      key="unassigned";
      if (!groups.has(key)) groups.set(key,{
        cwd:key,name:"No project",
        path:"Conversations without a Codex project assignment",
        projectId:null,kind:"unassigned",threads:[],activity:0,
      });
    }
    const group=groups.get(key);
    if (!group) continue;
    group.threads.push(thread);
    group.activity=Math.max(group.activity,activity(thread,archived));
  }
  for (const group of groups.values())
    group.threads.sort((a,b)=>activity(b,archived)-activity(a,archived)||a.id.localeCompare(b.id));
  if (view === "status") return [...groups.values()].filter(g=>g.threads.length>0);
  return [...groups.values()].sort((a,b)=>
    (sort==="recent"?b.activity-a.activity:0) ||
    a.name.localeCompare(b.name) || a.cwd.localeCompare(b.cwd));
}
