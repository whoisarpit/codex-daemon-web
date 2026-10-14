import { homedir } from "node:os";
import { isIP } from "node:net";
import { dirname, join, resolve } from "node:path";

export type DaemonEndpoint =
  | { kind: "unix"; path: string; label: string }
  | { kind: "websocket"; url: URL; label: string; authToken?: string };

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "::1") return true;
  return isIP(host) === 4 && Number(host.split(".")[0]) === 127;
}

function resolveDaemonEndpoint(): DaemonEndpoint {
  const configured = process.env.CODEX_APP_SERVER_URL;
  const authToken = process.env.CODEX_APP_SERVER_AUTH_TOKEN;

  if (!configured) {
    const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
    return {
      kind: "unix",
      path: join(codexHome, "app-server-control", "app-server-control.sock"),
      label: "local Codex app-server",
    };
  }

  if (configured.startsWith("unix://")) {
    const path = configured.slice("unix://".length);
    if (!path.startsWith("/") || path.includes("\0")) {
      throw new Error(
        "CODEX_APP_SERVER_URL must use an absolute Unix socket path",
      );
    }
    return { kind: "unix", path, label: "configured Unix socket" };
  }

  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new Error(
      "CODEX_APP_SERVER_URL must be a ws://, wss://, or unix:// URL",
    );
  }

  if (
    !["ws:", "wss:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash ||
    url.search
  ) {
    throw new Error(
      "CODEX_APP_SERVER_URL must be a ws:// or wss:// URL without credentials, query, or fragment",
    );
  }
  if (url.protocol === "ws:" && !isLoopback(url.hostname)) {
    throw new Error("Remote app-server endpoints must use wss://");
  }
  if (url.protocol === "wss:" && !isLoopback(url.hostname) && !authToken) {
    throw new Error(
      "CODEX_APP_SERVER_AUTH_TOKEN is required for remote wss:// endpoints",
    );
  }
  if (authToken && authToken.length < 16) {
    throw new Error(
      "CODEX_APP_SERVER_AUTH_TOKEN must contain at least 16 characters",
    );
  }

  return {
    kind: "websocket",
    url,
    label: `${url.protocol}//${url.host}${url.pathname}`,
    authToken,
  };
}

function parsePublicUrl(): URL | undefined {
  const value = process.env.PUBLIC_URL;
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      throw new Error();
    }
    return url;
  } catch {
    throw new Error("PUBLIC_URL must be an http:// or https:// URL");
  }
}

const port = Number(
  process.env.PORT || (process.env.NODE_ENV === "development" ? 3001 : 3000),
);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer from 1 to 65535");
}

const publicUrl = parsePublicUrl();
const allowedOrigins = new Set<string>();
for (const candidate of (process.env.ALLOWED_ORIGINS || "").split(",")) {
  const origin = candidate.trim();
  if (!origin) continue;
  try {
    const url = new URL(origin);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      throw new Error();
    }
    allowedOrigins.add(url.origin);
  } catch {
    throw new Error(`Invalid origin in ALLOWED_ORIGINS: ${origin}`);
  }
}
if (publicUrl) allowedOrigins.add(publicUrl.origin);
if (process.env.NODE_ENV === "development") {
  allowedOrigins.add("http://localhost:5173");
  allowedOrigins.add("http://127.0.0.1:5173");
}
allowedOrigins.add(`http://localhost:${port}`);
allowedOrigins.add(`http://127.0.0.1:${port}`);

const tokenPath = resolve(
  process.env.CODEX_WEB_TOKEN_FILE ||
    join(
      process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"),
      "codex-daemon-web",
      "access-token",
    ),
);

export const config = {
  host: process.env.HOST || "127.0.0.1",
  port,
  cookieSecure: parseBoolean(
    process.env.COOKIE_SECURE,
    publicUrl?.protocol === "https:",
  ),
  publicUrl,
  allowedOrigins,
  endpoint: resolveDaemonEndpoint(),
  tokenPath,
  sessionStatePath: resolve(join(dirname(tokenPath), "session-state.json")),
  pushStatePath: resolve(
    process.env.CODEX_WEB_PUSH_STATE_FILE ||
      join(dirname(tokenPath), "push-state.json"),
  ),
  scheduledTasksPath: resolve(
    process.env.CODEX_WEB_TASKS_FILE ||
      join(dirname(tokenPath), "scheduled-tasks.json"),
  ),
  scheduledTasksSocketPath: resolve(
    process.env.CODEX_WEB_TASKS_SOCKET_FILE ||
      join(dirname(tokenPath), "scheduled-tasks.sock"),
  ),
  defaultTokenPath: !process.env.CODEX_WEB_TOKEN_FILE,
  configuredAccessToken: process.env.CODEX_WEB_ACCESS_TOKEN,
  maxPayloadBytes: 1024 * 1024,
  connectTimeoutMs: 5000,
  initializeTimeoutMs: 10000,
  sessionMaxAgeMs: 180 * 24 * 60 * 60 * 1000,
  sessionRenewalWindowMs: 30 * 24 * 60 * 60 * 1000,
};
