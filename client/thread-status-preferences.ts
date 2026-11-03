import type { ThreadIndicator } from "./thread-status";

export type MarkerShape = "circle" | "square";
export type MarkerStyle = { enabled: boolean; color: string; shape: MarkerShape };
export type ThreadStatusPreferences = Record<ThreadIndicator, MarkerStyle>;
export const threadStatusPreferencesKey = "codex-web.thread-status.v1";
export const threadStatusOrder: ThreadIndicator[] = ["idle", "working", "decision", "waiting", "error"];
export const threadStatusLabels: Record<ThreadIndicator, string> = {
  idle: "Idle", working: "Working", decision: "Needs decision",
  waiting: "Agent / Scheduled", error: "Error",
};
export const defaultThreadStatusPreferences: ThreadStatusPreferences = {
  idle: { enabled: true, color: "#29a567", shape: "circle" },
  working: { enabled: true, color: "#29a567", shape: "square" },
  decision: { enabled: true, color: "#e7b13b", shape: "circle" },
  waiting: { enabled: true, color: "#e7b13b", shape: "square" },
  error: { enabled: true, color: "#dc4545", shape: "circle" },
};
export function readThreadStatusPreferences(storage: Pick<Storage, "getItem">): ThreadStatusPreferences {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(threadStatusPreferencesKey) || "null");
    const source = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    const result = {} as ThreadStatusPreferences;
    for (const key of threadStatusOrder) {
      const candidate = source[key] !== null && typeof source[key] === "object" && !Array.isArray(source[key]) ? source[key] as Record<string, unknown> : {};
      const fallback = defaultThreadStatusPreferences[key];
      result[key] = {
        enabled: typeof candidate.enabled === "boolean" ? candidate.enabled : fallback.enabled,
        color: typeof candidate.color === "string" && /^#[0-9a-fA-F]{6}$/.test(candidate.color) ? candidate.color : fallback.color,
        shape: candidate.shape === "circle" || candidate.shape === "square" ? candidate.shape : fallback.shape,
      };
    }
    return result;
  } catch { return structuredClone(defaultThreadStatusPreferences); }
}
