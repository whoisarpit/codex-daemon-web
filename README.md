# Codex Daemon Web

Codex Daemon Web is a reusable browser client and local bridge for the official Codex app-server. It attaches to an app-server that is already running under your Codex account. It does not start a daemon, create a private Codex home, or launch Codex commands on its own.

The bridge gives each authenticated browser WebSocket its own app-server connection. It initializes that connection as `codex-daemon-web`, then forwards JSON-RPC requests, responses, notifications, and server-initiated requests between the browser and the daemon. The browser owns JSON-RPC request IDs and must answer app-server requests such as approval and user input requests. No dynamic tools are registered by default.

## Requirements

- Node.js 20 or newer
- pnpm 12.10.1 (pinned in `package.json`)
- Codex CLI with app-server support

## Run locally

Start Codex's shared daemon in the same user account first:

```sh
codex app-server daemon start
```

Then start the web app:

```sh
pnpm install
pnpm dev
```

Open the Vite URL shown in the terminal, normally `http://127.0.0.1:5173`. The first server start creates a random access token at `~/.local/state/codex-daemon-web/access-token` (or `$XDG_STATE_HOME/codex-daemon-web/access-token`). Paste that token into the login screen. The file is kept outside the repository with owner-only permissions. You can replace it with `CODEX_WEB_ACCESS_TOKEN` or select another file with `CODEX_WEB_TOKEN_FILE`; configured access tokens must contain at least 32 characters.

The local Express server listens on `127.0.0.1:3001` during development and Vite proxies `/api`, including WebSocket upgrades, to it. The production server defaults to `127.0.0.1:3000` and serves the compiled client from `dist/client` alongside the backend in `dist/server`.

```sh
pnpm check
pnpm build
pnpm start
```

## Run in Docker with the host daemon

Running the web server directly on the host is the simplest way to use the default `$CODEX_HOME/app-server-control/app-server-control.sock` endpoint. The container image never starts a Codex daemon. If you run the bridge in Docker, start the shared host daemon first and give the bridge access only to its physical Unix-socket directory.

The bridge must run as the same numeric UID and GID that own the socket. The image defaults to `1000:1000`. Resolve the current socket target on the host before creating the container:

```sh
CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
SOCKET_TARGET="$(readlink -f "$CODEX_HOME/app-server-control/app-server-control.sock")"
test -S "$SOCKET_TARGET" || { echo "The shared Codex app-server socket is unavailable" >&2; exit 1; }
SOCKET_DIRECTORY="$(dirname "$SOCKET_TARGET")"
SOCKET_NAME="$(basename "$SOCKET_TARGET")"
```

Build and run the bridge in the existing Tailscale container's network namespace, replacing `codex-tailscale` with your existing Tailscale container name. This reuses that node's identity; it does not create another Tailscale node or publish a host port.

```sh
docker build -t codex-daemon-web:local .
docker volume create codex-daemon-web-state
docker run -d \
  --name codex-daemon-web \
  --network container:codex-tailscale \
  --user 1000:1000 \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m,mode=1777 \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --restart unless-stopped \
  --mount "type=bind,source=$SOCKET_DIRECTORY,target=/daemon-sockets,readonly" \
  --mount type=volume,source=codex-daemon-web-state,target=/var/lib/codex-daemon-web \
  --env CODEX_APP_SERVER_URL="unix:///daemon-sockets/$SOCKET_NAME" \
  --env PUBLIC_URL=https://codex.example.ts.net \
  --env ALLOWED_ORIGINS=https://codex.example.ts.net \
  --env COOKIE_SECURE=true \
  codex-daemon-web:local
```

The socket directory mount is read-only and contains the daemon socket, not the Codex home, app-server logs, authentication files, conversation history, workspace, or CLI runtime. The app-server still runs host-side and handles built-in tools with the host user's permissions. The separate named volume stores the web login token across container recreation. Keep the network namespace and reverse-proxy rules private; configure your existing proxy to reach `127.0.0.1:3000` inside that namespace only after verifying the new service.

The physical socket name is derived by Codex and can change between CLI implementations. Resolve the symlink again and recreate the container if the target basename changes. Mounting the whole physical socket directory lets the container see an ordinary daemon restart that replaces the socket inode at the same path. Do not mount only the socket file, because that can pin a stale inode. Confirm the resolved socket exists before starting the container; the web server will not start or restart the host daemon.

## Configuration

Environment variables can be set in the shell or in a local `.env` file (which is ignored by Git).

| Variable                      | Default                                                  | Purpose                                                                                                |
| ----------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `HOST`                        | `127.0.0.1`                                              | HTTP listen address. Keep loopback when using a local reverse proxy.                                   |
| `PORT`                        | `3000` in production, `3001` in development              | HTTP listen port.                                                                                      |
| `CODEX_HOME`                  | `~/.codex`                                               | Selects the Codex home containing the shared daemon control socket.                                    |
| `CODEX_APP_SERVER_URL`        | `$CODEX_HOME/app-server-control/app-server-control.sock` | Connect to `unix:///absolute/path`, `ws://`, or `wss://` app-server endpoint.                          |
| `CODEX_APP_SERVER_AUTH_TOKEN` | unset                                                    | Sends a Bearer token to a configured WebSocket endpoint. Required for non-loopback `wss://` endpoints. |
| `CODEX_WEB_ACCESS_TOKEN`      | generated token file                                     | Set a fixed login token; use at least 32 characters and keep it secret.                                |
| `CODEX_WEB_TOKEN_FILE`        | `$XDG_STATE_HOME/codex-daemon-web/access-token`          | Change where the generated login token is stored.                                                      |
| `CODEX_WEB_PUSH_STATE_FILE`   | next to the token file                                   | Change where the private VAPID key and browser subscriptions are stored.                               |
| `XDG_STATE_HOME`              | `~/.local/state`                                         | Base directory for application state and the generated token.                                          |
| `PUBLIC_URL`                  | unset                                                    | Public `http://` or `https://` origin when accessed through a reverse proxy.                           |
| `ALLOWED_ORIGINS`             | local app origins                                        | Comma-separated browser origins allowed for login and WebSocket upgrades.                              |
| `COOKIE_SECURE`               | enabled when `PUBLIC_URL` is HTTPS                       | Set to `true` when TLS terminates at a reverse proxy.                                                  |

By default, the backend finds the official Unix socket at `$CODEX_HOME/app-server-control/app-server-control.sock`. It does not search for private daemon paths or launch the daemon when that socket is absent. The socket must be available before browser sessions can connect.

For an app-server at another host, configure `CODEX_APP_SERVER_URL=wss://...` and `CODEX_APP_SERVER_AUTH_TOKEN`. Cleartext `ws://` is allowed only for loopback endpoints. The bridge never sends the daemon endpoint's authentication token to the browser.

## Reverse proxy

The HTTP server binds to loopback by default. A Tailscale Serve or other reverse proxy can publish it while the service remains local. Configure the public origin and secure cookie explicitly, for example:

```sh
PUBLIC_URL=https://codex.example.ts.net \
COOKIE_SECURE=true \
ALLOWED_ORIGINS=https://codex.example.ts.net \
pnpm start
```

The proxy must forward HTTP WebSocket upgrades to `/api/rpc`. The bridge validates the browser `Origin` against `PUBLIC_URL` and `ALLOWED_ORIGINS`; it does not trust `Forwarded` or `X-Forwarded-*` headers. Do not expose the service over an unauthenticated public network. Use TLS and an authenticated private network or reverse proxy.

## API and protocol notes

- `POST /api/login` accepts `{ "token": "..." }`, sets an `HttpOnly`, `SameSite=Strict` session cookie, and returns status.
- `GET /api/status` requires that cookie and returns `{ "authenticated": true, "daemon": { "available": boolean, "error?": string, "endpoint": string } }`.
- `POST /api/logout` clears the session cookie and immediately closes that login session's active browser connections.
- `GET /api/push/config`, `POST /api/push/subscription`, and `DELETE /api/push/subscription` require an authenticated session. The config response reports server readiness and its VAPID key; subscription routes persist each explicitly enabled browser.
- Authenticated WebSocket clients connect to `/api/rpc`. After the backend initializes the upstream app-server, it sends `{ "method": "bridge/ready", "params": {} }`. Bridge-local failures use `{ "method": "bridge/error", "params": { "message": "..." } }`.

The service worker displays a generic “Codex needs your input” notification and opens the encoded thread route when clicked. The push payload does not include question text. The bridge observes `item/tool/requestUserInput` requests on the existing browser connection and forwards them unchanged. The app-server protocol exposes these requests on the connection handling a thread; there is no global request event source, so notifications are sent only while a browser bridge is connected. Push cannot detect a question that arrives while the browser app is closed.

Install Codex Desk from the browser’s app menu to open it in a standalone window. Its root-scoped service worker handles push notifications for the installed app.

The browser must not send `initialize` or `initialized`; the bridge owns that handshake. It forwards app-server RPC messages after initialization. Every browser connection has independent upstream state and request IDs. WebSocket payloads are capped at 1 MiB, the bridge closes slow clients, and login attempts are rate limited by the direct peer address.

The app-server API evolves with Codex CLI releases. The bridge enables `experimentalApi`, so the browser client should treat protocol fields and methods as version-dependent. See the [official app-server documentation](https://developers.openai.com/codex/app-server).

## License

MIT. See [LICENSE](LICENSE).
