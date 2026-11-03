import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export function parseSidebarMetadata(value: unknown) {
  const state = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const projectless = Array.isArray(state["projectless-thread-ids"])
    ? state["projectless-thread-ids"].filter((id): id is string => typeof id === "string") : [];
  const assignments = state["thread-project-assignments"];
  const projectThreadIds = assignments && typeof assignments === "object" && !Array.isArray(assignments)
    ? Object.entries(assignments).filter(([, value]) =>
        value && typeof value === "object" &&
        typeof (value as Record<string, unknown>).projectId === "string"
      ).map(([id]) => id) : [];
  return { projectlessThreadIds: projectless, projectThreadIds };
}

// Read only the membership hints; never expose the rest of desktop state.
export async function readSidebarMetadata() {
  try {
    const path = join(process.env.CODEX_HOME || join(homedir(), ".codex"), ".codex-global-state.json");
    return parseSidebarMetadata(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return parseSidebarMetadata(null);
  }
}
