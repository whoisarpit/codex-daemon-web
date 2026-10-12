import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Request, Response } from "express";
import { config } from "./config.js";

const cookieName = "codex_daemon_web_session";
const sessions = new Map<string, number>();
const loginAttempts = new Map<string, number[]>();
const attemptWindowMs = 15 * 60 * 1000;
const maxAttempts = 10;
const maxTrackedClients = 5000;
const maxSessions = 10000;
const sessionRevocationListeners = new Set<(session: string) => void>();

let accessTokenPromise: Promise<string> | undefined;

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
      return decodeURIComponent(value.slice(separator + 1).trim());
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

function revokeSession(session: string): void {
  if (!sessions.delete(session)) return;
  for (const listener of sessionRevocationListeners) {
    try {
      listener(session);
    } catch {
      continue;
    }
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

function removeExpiredSessions(now: number): void {
  for (const [session, expiry] of sessions) {
    if (expiry <= now) revokeSession(session);
  }
}

const cleanupTimer = setInterval(() => {
  const now = Date.now();
  removeExpiredAttempts(now);
  removeExpiredSessions(now);
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
  removeExpiredSessions(Date.now());
  if (sessions.size >= maxSessions) {
    response.status(503).json({ error: "Too many active sessions" });
    return false;
  }
  const expiry = Date.now() + config.sessionMaxAgeMs;
  sessions.set(session, expiry);
  setCookie(response, session, Math.floor(config.sessionMaxAgeMs / 1000));
  return true;
}

export function authenticatedSession(request: Request): string | undefined {
  const session = cookieValue(request);
  if (!session) return undefined;
  return isSessionActive(session) ? session : undefined;
}

export function isSessionActive(session: string): boolean {
  const expiry = sessions.get(session);
  if (!expiry) return false;
  if (expiry <= Date.now()) {
    revokeSession(session);
    return false;
  }
  return true;
}

export function sessionExpiresAt(session: string): number | undefined {
  return isSessionActive(session) ? sessions.get(session) : undefined;
}

export function onSessionRevoked(
  listener: (session: string) => void,
): () => void {
  sessionRevocationListeners.add(listener);
  return () => sessionRevocationListeners.delete(listener);
}

export function logout(request: Request, response: Response): void {
  const session = cookieValue(request);
  if (session) revokeSession(session);
  setCookie(response, "", 0);
  response.status(204).end();
}

export async function prepareAuthentication(): Promise<void> {
  await getAccessToken();
}
