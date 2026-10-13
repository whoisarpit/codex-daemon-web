import "dotenv/config";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { attachBridge } from "./bridge.js";
import {
  authenticatedSession,
  login,
  logout,
  prepareAuthentication,
  renewSessionCookie,
} from "./auth.js";
import { config } from "./config.js";
import { daemonAvailable, endpointLabel } from "./daemon.js";
import {
  deletePushSubscription,
  pushConfiguration,
  savePushSubscription,
} from "./push.js";

const app = express();
const server = createServer(app);

function originAllowed(origin: string | undefined): boolean {
  return Boolean(origin && config.allowedOrigins.has(origin));
}

function requireBrowserOrigin(
  request: express.Request,
  response: express.Response,
  next: express.NextFunction,
): void {
  if (!originAllowed(request.header("origin"))) {
    response.status(403).json({ error: "Request origin is not allowed" });
    return;
  }
  next();
}

async function requireSession(
  request: express.Request,
  response: express.Response,
  next: express.NextFunction,
): Promise<void> {
  const session = authenticatedSession(request);
  if (!session) {
    response.status(401).json({ authenticated: false });
    return;
  }
  if (!(await renewSessionCookie(session, response))) {
    response.status(401).json({ authenticated: false });
    return;
  }
  next();
}

async function statusPayload() {
  const available = await daemonAvailable();
  return {
    authenticated: true,
    daemon: {
      available,
      ...(available ? {} : { error: "Codex app-server is unavailable" }),
      endpoint: endpointLabel(),
    },
  };
}

app.disable("x-powered-by");
app.use((_request, response, next) => {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "same-origin");
  response.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=()",
  );
  next();
});
app.use(express.json({ limit: "16kb", strict: true }));

app.post(
  "/api/login",
  requireBrowserOrigin,
  async (request, response, next) => {
    try {
      const succeeded = await login(request, response, request.body?.token);
      if (!succeeded) return;
      response.json(await statusPayload());
    } catch (error) {
      next(error);
    }
  },
);

app.get("/api/status", requireSession, async (_request, response, next) => {
  try {
    response.json(await statusPayload());
  } catch (error) {
    next(error);
  }
});

app.get(
  "/api/push/config",
  requireSession,
  async (_request, response, next) => {
    try {
      response.setHeader("Cache-Control", "no-store");
      response.json(await pushConfiguration());
    } catch (error) {
      next(error);
    }
  },
);

app.post(
  "/api/push/subscription",
  requireBrowserOrigin,
  requireSession,
  async (request, response, next) => {
    try {
      response.status(201).json(await savePushSubscription(request.body));
    } catch (error) {
      next(error);
    }
  },
);

app.delete(
  "/api/push/subscription",
  requireBrowserOrigin,
  requireSession,
  async (request, response, next) => {
    try {
      response.json(await deletePushSubscription(request.body?.endpoint));
    } catch (error) {
      next(error);
    }
  },
);

app.post(
  "/api/logout",
  requireBrowserOrigin,
  requireSession,
  async (request, response) => logout(request, response),
);

app.use("/api", (_request, response) =>
  response.status(404).json({ error: "API route not found" }),
);

if (process.env.NODE_ENV !== "development") {
  const serverDirectory = dirname(fileURLToPath(import.meta.url));
  const clientDirectory = resolve(serverDirectory, "../client");
  const entryFile = resolve(clientDirectory, "index.html");
  if (existsSync(entryFile)) {
    app.use(
      express.static(clientDirectory, {
        index: false,
        fallthrough: true,
        maxAge: "1h",
        setHeaders: (response, path) => {
          if (path.endsWith("/service-worker.js")) {
            response.setHeader("Cache-Control", "no-cache");
          }
        },
      }),
    );
    app.get("/{*path}", (_request, response, next) => {
      response.setHeader("Cache-Control", "no-store");
      response.sendFile(entryFile, (error) => {
        if (error) next(error);
      });
    });
  }
}

app.use(
  (
    error: unknown,
    _request: express.Request,
    response: express.Response,
    _next: express.NextFunction,
  ) => {
    if (response.headersSent) return;
    const status =
      typeof error === "object" && error !== null && "status" in error
        ? Number(error.status)
        : 500;
    response
      .status(status >= 400 && status < 600 ? status : 500)
      .json({ error: "Request could not be completed" });
  },
);

const closeBridge = attachBridge(server);

await prepareAuthentication();
server.listen(config.port, config.host, () => {
  process.stdout.write(
    `Codex Daemon Web listening on http://${config.host}:${config.port}\n`,
  );
  if (!config.configuredAccessToken) {
    process.stdout.write(`Access token file: ${config.tokenPath}\n`);
  }
});

function shutdown(): void {
  closeBridge();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
