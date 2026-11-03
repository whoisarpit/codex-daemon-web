/** In-process registry of daemon writers owned by authenticated WebUI sockets. */
export type ThreadOwner = {
  call: (method: string, params: Record<string, unknown>) => Promise<Record<string, any>>;
  waitForTurn: (threadId: string, turnId: string) => Promise<{ status: string }>;
};
const owners = new Map<string, ThreadOwner>();
export function claimThreadWriter(threadId: string, owner: ThreadOwner) {
  if (threadId) owners.set(threadId, owner);
}
export function releaseThreadWriter(owner: ThreadOwner) {
  for (const [id, value] of owners) if (value === owner) owners.delete(id);
}
export function threadWriter(threadId: string): ThreadOwner | undefined {
  return owners.get(threadId);
}

export function releaseThreadWriterFor(threadId: string, owner: ThreadOwner) {
  if (owners.get(threadId) === owner) owners.delete(threadId);
}

/** Explicit daemon rejection means turn/start did not begin; retry is safe. */
export class BridgeRpcRejectedError extends Error {
  constructor(message: string) { super(message); this.name = "BridgeRpcRejectedError"; }
}
