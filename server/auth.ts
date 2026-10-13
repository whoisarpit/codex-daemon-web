import { constants as fsConstants } from "node:fs";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import { dirname } from "node:path";
import type { Request, Response } from "express";
import { config } from "./config.js";

const cookieName = "codex_daemon_web_session";
const sessions = new Map<string, number>();
const sessionIds = new Map<string, string>();
const loginAttempts = new Map<string, number[]>();
const attemptWindowMs = 15 * 60 * 1000;
const maxAttempts = 10;
const maxTrackedClients = 5000;
const maxSessions = 10000;
const maxSessionStateBytes = 2_000_000;
const sessionRevocationListeners = new Set<(session: string) => void>();

interface SessionState {
  version: 1;
  tokenFingerprint: string;
  sessions: Array<{ idHash: string; expiresAt: number }>;
}

let accessTokenPromise: Promise<string> | undefined;
let tokenFingerprint: string | undefined;
let sessionMutation = Promise.resolve();
let expirationCleanupScheduled = false;

async function createAccessToken(): Promise<string> {
  if (config.configuredAccessToken) {
    if (config.configuredAccessToken.length < 32) {
      throw new Error(
        "CODEX_WEB_ACCESS_TOKEN must contain at least 32 characters",
      );
    }
    return config.configuredAccessToken;
  }

  const tokenDirectory = dirname(config.tokenPath);
  await mkdir(tokenDirectory, { recursive: true, mode: 0o700 });
  const directoryDetails = await lstat(tokenDirectory);
  if (!directoryDetails.isDirectory())
    throw new Error("Access token directory must be a real directory");
  if (
    typeof process.getuid === "function" &&
    directoryDetails.uid !== process.getuid()
  ) {
    throw new Error("Access token directory must be owned by the current user");
  }
  if ((directoryDetails.mode & 0o077) !== 0) {
    if (!config.defaultTokenPath) {
      throw new Error(
        "Custom access token directory must be private to the current user",
      );
    }
    await chmod(tokenDirectory, 0o700);
  }

  try {
    const details = await lstat(config.tokenPath);
    if (!details.isFile())
      throw new Error("Access token path must be a regular file");
    if (
      typeof process.getuid === "function" &&
      details.uid !== process.getuid()
    ) {
      throw new Error("Access token file must be owned by the current user");
    }
    if ((details.mode & 0o077) !== 0) await chmod(config.tokenPath, 0o600);
    const token = (await readFile(config.tokenPath, "utf8")).trim();
    if (token.length < 32)
      throw new Error("Access token file is empty or too short");
    return token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const token = randomBytes(32).toString("base64url");
  try {
    const file = await open(config.tokenPath, "wx", 0o600);
    try {
      await file.writeFile(`${token}\n`, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    return token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const details = await lstat(config.tokenPath);
    if (!details.isFile())
      throw new Error("Access token path must be a regular file");
    if (
      typeof process.getuid === "function" &&
      details.uid !== process.getuid()
    ) {
      throw new Error("Access token file must be owned by the current user");
    }
    if ((details.mode & 0o077) !== 0) await chmod(config.tokenPath, 0o600);
    const token = (await readFile(config.tokenPath, "utf8")).trim();
    if (token.length < 32)
      throw new Error("Access token file is empty or too short");
    return token;
  }
}

function getAccessToken(): Promise<string> {
  accessTokenPromise ??= createAccessToken();
  return accessTokenPromise;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function tokenMatches(candidate: string, expected: string): boolean {
  const candidateHash = createHash("sha256").update(candidate).digest();
  const expectedHash = createHash("sha256").update(expected).digest();
  return timingSafeEqual(candidateHash, expectedHash);
}

function cookieValue(request: Request): string | undefined {
  const header = request.headers.cookie;
  if (!header) return undefined;
  for (const value of header.split(";")) {
    const separator = value.indexOf("=");
    if (separator < 0 || value.slice(0, separator).trim() !== cookieName)
      continue;
    try {
      const session = decodeURIComponent(value.slice(separator + 1).trim());
      return /^[A-Za-z0-9_-]{43}$/.test(session) ? session : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function setCookie(
  response: Response,
  value: string,
  maxAgeSeconds: number,
): void {
  const attributes = [
    `${cookieName}=${encodeURIComponent(value)}`,
    "Path=/api",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (config.cookieSecure) attributes.push("Secure");
  response.setHeader("Set-Cookie", attributes.join("; "));
}

function clientKey(request: Request): string {
  return request.socket.remoteAddress || "unknown";
}

function notifySessionRevoked(idHash: string, session?: string): void {
  const sessionId = session || sessionIds.get(idHash);
  sessionIds.delete(idHash);
  if (!sessionId) return;
  for (const listener of sessionRevocationListeners) {
    try {
      listener(sessionId);
    } catch {
      continue;
    }
  }
}

function enqueueSessionMutation<T>(mutation: () => Promise<T>): Promise<T> {
  const result = sessionMutation.then(mutation);
  sessionMutation = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function sessionState(nextSessions: Map<string, number>): SessionState {
  if (!tokenFingerprint) throw new Error("Session state is not initialized");
  return {
    version: 1,
    tokenFingerprint,
    sessions: [...nextSessions].map(([idHash, expiresAt]) => ({
      idHash,
      expiresAt,
    })),
  };
}

async function ensureSessionStateDirectory(): Promise<void> {
  const directory = dirname(config.sessionStatePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const details = await lstat(directory);
  if (!details.isDirectory())
    throw new Error("Session state directory must be a real directory");
  if (
    typeof process.getuid === "function" &&
    details.uid !== process.getuid()
  ) {
    throw new Error(
      "Session state directory must be owned by the current user",
    );
  }
  if ((details.mode & 0o077) !== 0) await chmod(directory, 0o700);
}

async function writeSessionState(
  nextSessions: Map<string, number>,
): Promise<void> {
  await ensureSessionStateDirectory();
  const directory = dirname(config.sessionStatePath);
  const temporaryPath = `${config.sessionStatePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  let temporaryCreated = false;
  try {
    const file = await open(temporaryPath, "wx", 0o600);
    temporaryCreated = true;
    try {
      await file.writeFile(
        `${JSON.stringify(sessionState(nextSessions))}\n`,
        "utf8",
      );
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporaryPath, config.sessionStatePath);
    temporaryCreated = false;
    const directoryHandle = await open(
      directory,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
    );
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } finally {
    if (temporaryCreated) {
      await unlink(temporaryPath).catch(() => undefined);
    }
  }
}

async function readSessionState(): Promise<SessionState | undefined> {
  let file;
  try {
    file = await open(
      config.sessionStatePath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new Error("Session state path must not be a symbolic link");
    }
    throw error;
  }
  try {
    const details = await file.stat();
    if (!details.isFile())
      throw new Error("Session state path must be a regular file");
    if (details.size > maxSessionStateBytes)
      throw new Error("Session state file is too large");
    if (
      typeof process.getuid === "function" &&
      details.uid !== process.getuid()
    ) {
      throw new Error("Session state file must be owned by the current user");
    }
    if ((details.mode & 0o077) !== 0) await file.chmod(0o600);
    const value: unknown = JSON.parse(await file.readFile("utf8"));
    if (!value || typeof value !== "object")
      throw new Error("Session state file is invalid");
    const state = value as Partial<SessionState>;
    if (
      state.version !== 1 ||
      typeof state.tokenFingerprint !== "string" ||
      !/^[a-f0-9]{64}$/.test(state.tokenFingerprint) ||
      !Array.isArray(state.sessions) ||
      state.sessions.length > maxSessions
    ) {
      throw new Error("Session state file is invalid");
    }
    for (const record of state.sessions) {
      if (
        !record ||
        typeof record.idHash !== "string" ||
        !/^[a-f0-9]{64}$/.test(record.idHash) ||
        typeof record.expiresAt !== "number" ||
        !Number.isSafeInteger(record.expiresAt)
      ) {
        throw new Error("Session state file is invalid");
      }
    }
    return state as SessionState;
  } finally {
    await file.close();
  }
}

function removeExpiredAttempts(now: number): void {
  for (const [key, timestamps] of loginAttempts) {
    const active = timestamps.filter(
      (timestamp) => now - timestamp < attemptWindowMs,
    );
    if (active.length === 0) loginAttempts.delete(key);
    else loginAttempts.set(key, active);
  }
}

function scheduleExpiredSessionCleanup(now: number): void {
  if (expirationCleanupScheduled) return;
  const expiredHashes = [...sessions]
    .filter(([, expiry]) => expiry <= now)
    .map(([idHash]) => idHash);
  if (expiredHashes.length === 0) return;
  expirationCleanupScheduled = true;
  for (const idHash of expiredHashes) notifySessionRevoked(idHash);
  void enqueueSessionMutation(async () => {
    const next = new Map(sessions);
    for (const idHash of expiredHashes) {
      if ((next.get(idHash) || 0) <= Date.now()) next.delete(idHash);
    }
    if (next.size !== sessions.size) {
      await writeSessionState(next);
      sessions.clear();
      for (const [idHash, expiry] of next) sessions.set(idHash, expiry);
    }
  })
    .catch(() => undefined)
    .finally(() => {
      expirationCleanupScheduled = false;
    });
}

const cleanupTimer = setInterval(() => {
  const now = Date.now();
  removeExpiredAttempts(now);
  scheduleExpiredSessionCleanup(now);
}, 60_000);
cleanupTimer.unref();

function recordAttempt(request: Request): boolean {
  const now = Date.now();
  const key = clientKey(request);
  if (!loginAttempts.has(key) && loginAttempts.size >= maxTrackedClients) {
    removeExpiredAttempts(now);
    if (loginAttempts.size >= maxTrackedClients) return false;
  }
  const active = (loginAttempts.get(key) || []).filter(
    (timestamp) => now - timestamp < attemptWindowMs,
  );
  if (active.length >= maxAttempts) {
    loginAttempts.set(key, active);
    return false;
  }
  active.push(now);
  loginAttempts.set(key, active);
  return true;
}

export async function login(
  request: Request,
  response: Response,
  candidate: unknown,
): Promise<boolean> {
  if (!recordAttempt(request)) {
    response
      .status(429)
      .json({ error: "Too many login attempts. Try again later." });
    return false;
  }

  const expected = await getAccessToken();
  if (
    typeof candidate !== "string" ||
    candidate.length > 1024 ||
    !tokenMatches(candidate, expected)
  ) {
    response.status(401).json({ error: "Invalid access token" });
    return false;
  }

  const session = randomBytes(32).toString("base64url");
  const idHash = hash(session);
  const expiry = await enqueueSessionMutation(async () => {
    const now = Date.now();
    const next = new Map(
      [...sessions].filter(([, sessionExpiry]) => sessionExpiry > now),
    );
    for (const [existingHash, existingExpiry] of sessions) {
      if (existingExpiry <= now) notifySessionRevoked(existingHash);
    }
    if (next.size >= maxSessions) return undefined;
    const sessionExpiry = now + config.sessionMaxAgeMs;
    next.set(idHash, sessionExpiry);
    await writeSessionState(next);
    sessions.clear();
    for (const [existingHash, existingExpiry] of next) {
      sessions.set(existingHash, existingExpiry);
    }
    sessionIds.set(idHash, session);
    return sessionExpiry;
  });
  if (!expiry) {
    response.status(503).json({ error: "Too many active sessions" });
    return false;
  }
  setCookie(response, session, Math.floor(config.sessionMaxAgeMs / 1000));
  return true;
}

export function authenticatedSession(request: Request): string | undefined {
  const session = cookieValue(request);
  if (!session) return undefined;
  return isSessionActive(session) ? session : undefined;
}

export function isSessionActive(session: string): boolean {
  const idHash = hash(session);
  const expiry = sessions.get(idHash);
  if (!expiry) return false;
  if (expiry <= Date.now()) {
    notifySessionRevoked(idHash, session);
    scheduleExpiredSessionCleanup(Date.now());
    return false;
  }
  sessionIds.set(idHash, session);
  return true;
}

export async function renewSessionCookie(
  session: string,
  response: Response,
): Promise<boolean> {
  const idHash = hash(session);
  const result = await enqueueSessionMutation(async () => {
    const currentExpiry = sessions.get(idHash);
    if (!currentExpiry) return undefined;
    const now = Date.now();
    if (currentExpiry <= now) {
      const next = new Map(sessions);
      next.delete(idHash);
      await writeSessionState(next);
      sessions.clear();
      for (const [existingHash, expiry] of next) {
        sessions.set(existingHash, expiry);
      }
      notifySessionRevoked(idHash, session);
      return undefined;
    }
    if (currentExpiry - now > config.sessionRenewalWindowMs) {
      sessionIds.set(idHash, session);
      return { expiry: currentExpiry, renewed: false };
    }
    const next = new Map(sessions);
    const renewedExpiry = now + config.sessionMaxAgeMs;
    next.set(idHash, renewedExpiry);
    await writeSessionState(next);
    sessions.clear();
    for (const [existingHash, expiry] of next) {
      sessions.set(existingHash, expiry);
    }
    sessionIds.set(idHash, session);
    return { expiry: renewedExpiry, renewed: true };
  });
  if (!result) return false;
  if (result.renewed) {
    setCookie(
      response,
      session,
      Math.max(0, Math.floor((result.expiry - Date.now()) / 1000)),
    );
  }
  return true;
}

export function sessionExpiresAt(session: string): number | undefined {
  const idHash = hash(session);
  return isSessionActive(session) ? sessions.get(idHash) : undefined;
}

export function onSessionRevoked(
  listener: (session: string) => void,
): () => void {
  sessionRevocationListeners.add(listener);
  return () => sessionRevocationListeners.delete(listener);
}

export async function logout(
  request: Request,
  response: Response,
): Promise<void> {
  const session = cookieValue(request);
  if (session) {
    const idHash = hash(session);
    await enqueueSessionMutation(async () => {
      const next = new Map(sessions);
      if (!next.delete(idHash)) {
        notifySessionRevoked(idHash, session);
        return;
      }
      await writeSessionState(next);
      sessions.clear();
      for (const [existingHash, expiry] of next) {
        sessions.set(existingHash, expiry);
      }
      notifySessionRevoked(idHash, session);
    });
  }
  setCookie(response, "", 0);
  response.status(204).end();
}

export async function prepareAuthentication(): Promise<void> {
  const accessToken = await getAccessToken();
  tokenFingerprint = hash(accessToken);
  await ensureSessionStateDirectory();
  const storedState = await readSessionState();
  if (!storedState || storedState.tokenFingerprint !== tokenFingerprint) return;
  const now = Date.now();
  const loaded = new Map<string, number>();
  for (const record of storedState.sessions) {
    if (record.expiresAt > now) loaded.set(record.idHash, record.expiresAt);
  }
  for (const [idHash, expiry] of loaded) sessions.set(idHash, expiry);
  if (loaded.size !== storedState.sessions.length) {
    await writeSessionState(loaded);
  }
}
