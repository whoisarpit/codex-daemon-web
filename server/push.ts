import { randomBytes } from "node:crypto";
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
import { dirname, join } from "node:path";
import webpush, { type PushSubscription } from "web-push";
import { config } from "./config.js";

const maxSubscriptions = 100;
const maxStoreBytes = 512 * 1024;
const allowedPushHosts = new Set([
  "fcm.googleapis.com",
  "updates.push.services.mozilla.com",
  "push.services.mozilla.com",
  "web.push.apple.com",
]);

type PushStore = {
  version: 1;
  publicKey: string;
  privateKey: string;
  subscriptions: PushSubscription[];
};

let storePromise: Promise<PushStore> | undefined;
let mutationQueue = Promise.resolve();

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validEndpoint(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const endpoint = new URL(value);
    return (
      endpoint.protocol === "https:" &&
      !endpoint.username &&
      !endpoint.password &&
      !endpoint.hash &&
      (!endpoint.port || endpoint.port === "443") &&
      allowedPushHosts.has(endpoint.hostname.toLowerCase())
    );
  } catch {
    return false;
  }
}

function validKey(value: unknown, byteLength: number): value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value))
    return false;
  try {
    return Buffer.from(value, "base64url").byteLength === byteLength;
  } catch {
    return false;
  }
}

function normalizeSubscription(value: unknown): PushSubscription {
  if (!isRecord(value) || !validEndpoint(value.endpoint))
    throw requestError("Invalid push subscription endpoint", 400);
  if (!isRecord(value.keys))
    throw requestError("Invalid push subscription keys", 400);
  if (!validKey(value.keys.p256dh, 65) || !validKey(value.keys.auth, 16))
    throw requestError("Invalid push subscription keys", 400);
  return {
    endpoint: value.endpoint,
    keys: { p256dh: value.keys.p256dh, auth: value.keys.auth },
  };
}

async function prepareStateDirectory(): Promise<string> {
  const directory = dirname(config.pushStatePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const details = await lstat(directory);
  if (!details.isDirectory())
    throw new Error("Push state directory must be a real directory");
  if (
    typeof process.getuid === "function" &&
    details.uid !== process.getuid()
  ) {
    throw new Error("Push state directory must be owned by the current user");
  }
  if ((details.mode & 0o077) !== 0) await chmod(directory, 0o700);
  return directory;
}

async function writeStore(store: PushStore): Promise<void> {
  const directory = await prepareStateDirectory();
  const temporaryPath = join(
    directory,
    `.push-state-${process.pid}-${randomBytes(8).toString("hex")}.tmp`,
  );
  const contents = `${JSON.stringify(store)}\n`;
  if (Buffer.byteLength(contents, "utf8") > maxStoreBytes)
    throw new Error("Push state exceeds the storage limit");

  try {
    const file = await open(temporaryPath, "wx", 0o600);
    try {
      await file.writeFile(contents, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporaryPath, config.pushStatePath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function parseStore(value: unknown): PushStore {
  if (!isRecord(value) || value.version !== 1)
    throw new Error("Push state file has an unsupported format");
  if (
    !validKey(value.publicKey, 65) ||
    !validKey(value.privateKey, 32) ||
    !Array.isArray(value.subscriptions) ||
    value.subscriptions.length > maxSubscriptions
  ) {
    throw new Error("Push state file is invalid");
  }
  let subscriptions: PushSubscription[];
  try {
    subscriptions = value.subscriptions.map(normalizeSubscription);
  } catch {
    throw new Error("Push state file subscriptions are invalid");
  }
  return {
    version: 1,
    publicKey: value.publicKey,
    privateKey: value.privateKey,
    subscriptions,
  };
}

async function loadStoreOnce(): Promise<PushStore> {
  await prepareStateDirectory();
  try {
    const details = await lstat(config.pushStatePath);
    if (!details.isFile()) throw new Error("Push state path must be a file");
    if (
      typeof process.getuid === "function" &&
      details.uid !== process.getuid()
    ) {
      throw new Error("Push state file must be owned by the current user");
    }
    if ((details.mode & 0o077) !== 0) await chmod(config.pushStatePath, 0o600);
    const fileDetails = await stat(config.pushStatePath);
    if (fileDetails.size > maxStoreBytes)
      throw new Error("Push state file exceeds the storage limit");
    const contents = await readFile(config.pushStatePath, "utf8");
    const store = parseStore(JSON.parse(contents) as unknown);
    configureWebPush(store);
    return store;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const keys = webpush.generateVAPIDKeys();
  const store: PushStore = {
    version: 1,
    publicKey: keys.publicKey,
    privateKey: keys.privateKey,
    subscriptions: [],
  };
  await writeStore(store);
  configureWebPush(store);
  return store;
}

function loadStore(): Promise<PushStore> {
  storePromise ??= loadStoreOnce().catch((error: unknown) => {
    storePromise = undefined;
    throw error;
  });
  return storePromise;
}

function configureWebPush(store: PushStore): void {
  const subject =
    (config.publicUrl?.protocol === "https:" && config.publicUrl.toString()) ||
    "mailto:codex-daemon-web@localhost";
  webpush.setVapidDetails(subject, store.publicKey, store.privateKey);
}

function withMutation<T>(
  mutation: (store: PushStore) => Promise<T>,
): Promise<T> {
  const current = mutationQueue.then(async () => {
    const loaded = await loadStore();
    const draft: PushStore = {
      ...loaded,
      subscriptions: loaded.subscriptions.map((subscription) => ({
        endpoint: subscription.endpoint,
        keys: { ...subscription.keys },
      })),
    };
    return mutation(draft);
  });
  mutationQueue = current.then(
    () => undefined,
    () => undefined,
  );
  return current;
}

async function persistMutation(store: PushStore): Promise<void> {
  await writeStore(store);
  storePromise = Promise.resolve(store);
}

export async function pushConfiguration(): Promise<{
  enabled: true;
  publicKey: string;
}> {
  return { enabled: true, publicKey: (await loadStore()).publicKey };
}

export async function savePushSubscription(
  value: unknown,
): Promise<{ saved: true }> {
  const subscription = normalizeSubscription(value);
  return withMutation(async (store) => {
    const index = store.subscriptions.findIndex(
      (entry) => entry.endpoint === subscription.endpoint,
    );
    if (index < 0 && store.subscriptions.length >= maxSubscriptions)
      throw requestError("Push subscription limit reached", 409);
    if (index < 0) store.subscriptions.push(subscription);
    else store.subscriptions[index] = subscription;
    await persistMutation(store);
    return { saved: true };
  });
}

export async function deletePushSubscription(
  endpoint: unknown,
): Promise<{ removed: boolean }> {
  if (!validEndpoint(endpoint))
    throw requestError("Invalid push subscription endpoint", 400);
  return withMutation(async (store) => {
    const index = store.subscriptions.findIndex(
      (entry) => entry.endpoint === endpoint,
    );
    if (index < 0) return { removed: false };
    store.subscriptions.splice(index, 1);
    await persistMutation(store);
    return { removed: true };
  });
}

function requestError(message: string, status: number): Error {
  return Object.assign(new Error(message), { status });
}

function errorStatus(error: unknown): number | undefined {
  if (!isRecord(error) || typeof error.statusCode !== "number")
    return undefined;
  return error.statusCode;
}

export function notifyUserInput(threadId: string): void {
  void (async () => {
    const store = await loadStore();
    if (store.subscriptions.length === 0) return;
    const url = `/#/thread/${encodeURIComponent(threadId)}`;
    const payload = JSON.stringify({
      title: "Codex needs your input",
      body: "Open Codex to respond.",
      url,
    });
    const expired: string[] = [];
    for (let offset = 0; offset < store.subscriptions.length; offset += 3) {
      const batch = store.subscriptions.slice(offset, offset + 3);
      const results = await Promise.allSettled(
        batch.map((subscription) =>
          webpush.sendNotification(subscription, payload, {
            TTL: 3600,
            urgency: "high",
          }),
        ),
      );
      results.forEach((result, index) => {
        if (
          result.status === "rejected" &&
          [404, 410].includes(errorStatus(result.reason) ?? 0)
        ) {
          expired.push(batch[index].endpoint);
        }
      });
    }
    if (expired.length > 0) {
      await withMutation(async (current) => {
        current.subscriptions = current.subscriptions.filter(
          (subscription) => !expired.includes(subscription.endpoint),
        );
        await persistMutation(current);
      });
    }
  })().catch(() => undefined);
}
