# Configuration and operations

Codex Daemon Web connects to an app-server that is already running under your Codex account. The web process does not start Codex or create a separate Codex home. Run the web process as the same operating-system user that owns the app-server socket and the projects Codex should access.

## Production start

From the repository, build the client and server, then run the production server:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

The production server listens on `127.0.0.1:3000` by default and serves both the web client and API. The development command `pnpm dev` uses Vite on `127.0.0.1:5173` and the API server on `127.0.0.1:3001`.

Create a local `.env` file when you need to set options. For private HTTPS access through Tailscale Serve, for example:

```dotenv
HOST=127.0.0.1
PORT=3000
PUBLIC_URL=https://codex.example.ts.net
ALLOWED_ORIGINS=https://codex.example.ts.net
COOKIE_SECURE=true
```

Set `PUBLIC_URL` and `ALLOWED_ORIGINS` to the exact HTTPS origin that browsers will use. The app validates browser origins against these values and does not rely on forwarded host headers. See the [Tailscale setup guide](tailscale.md) for the full private-access setup.

## Environment variables

| Variable                      | Default                                                  | Purpose                                                                                                          |
| ----------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `HOST`                        | `127.0.0.1`                                              | HTTP listen address. Keep this on loopback when a local reverse proxy provides remote access.                    |
| `PORT`                        | `3000` in production; `3001` in development              | HTTP listen port.                                                                                                |
| `CODEX_HOME`                  | `~/.codex`                                               | Codex home containing the app-server socket.                                                                     |
| `CODEX_APP_SERVER_URL`        | `$CODEX_HOME/app-server-control/app-server-control.sock` | Unix socket (`unix:///absolute/path`) or app-server WebSocket (`ws://` or `wss://`) endpoint.                    |
| `CODEX_APP_SERVER_AUTH_TOKEN` | unset                                                    | Bearer token for a configured WebSocket endpoint. Required for non-loopback `wss://`; never sent to the browser. |
| `CODEX_WEB_ACCESS_TOKEN`      | generated token file                                     | Set a fixed web login token. Use at least 32 characters and keep it private.                                     |
| `CODEX_WEB_TOKEN_FILE`        | `$XDG_STATE_HOME/codex-daemon-web/access-token`          | Location for the generated web login token.                                                                      |
| `XDG_STATE_HOME`              | `~/.local/state`                                         | Base directory for the default token and application state.                                                      |
| `CODEX_WEB_PUSH_STATE_FILE`   | `push-state.json` beside the token                       | Location for the private push key and browser subscriptions.                                                     |
| `CODEX_WEB_TASKS_FILE`        | `scheduled-tasks.json` beside the token                  | Location for scheduled task definitions and run history.                                                         |
| `CODEX_WEB_TASKS_SOCKET_FILE` | `scheduled-tasks.sock` beside the token                  | Local control socket used by the optional scheduled-task MCP server.                                             |
| `CODEX_WEB_BROWSER_SOCKET`    | `/browser-socket/codex-web-browser-backend.sock`         | Unix socket for an optional compatible browser backend.                                                          |
| `PUBLIC_URL`                  | unset                                                    | Public `http://` or `https://` origin used by a reverse proxy.                                                   |
| `ALLOWED_ORIGINS`             | local app origins                                        | Comma-separated list of browser origins permitted to log in and open WebSockets. `PUBLIC_URL` is also allowed.   |
| `COOKIE_SECURE`               | enabled when `PUBLIC_URL` uses HTTPS                     | Mark the login cookie secure when TLS ends at a proxy.                                                           |

By default, the app connects to `$CODEX_HOME/app-server-control/app-server-control.sock`. It does not search private daemon locations or start the daemon when the socket is missing. Start `codex app-server daemon start` under the intended OS account before connecting a browser.

For a remote app-server, use `CODEX_APP_SERVER_URL=wss://...` and set `CODEX_APP_SERVER_AUTH_TOKEN`. The app permits cleartext `ws://` only for loopback endpoints. It never forwards the app-server bearer token to the browser.

## Login and state

On first startup, the app creates a random web login token outside the repository with owner-only file permissions. Read the value locally and enter it in the login screen. A fixed token can be supplied through `CODEX_WEB_ACCESS_TOKEN`; it must contain at least 32 characters.

Login uses an `HttpOnly`, `SameSite=Strict` cookie with a 180-day lifetime. Session records persist beside the token file, so an existing browser login survives a server restart. Authenticated activity renews the cookie when fewer than 30 days remain. Changing the access token invalidates saved sessions.

Scheduled task definitions, run history, push subscriptions, and push keys are stored in the configured state directory. Back up this directory if those records matter to you, and protect it like other account state. Push notifications contain a generic alert, not the question text. A browser must be subscribed and the server must be running when a scheduled question is raised to receive a push alert.

The built-in credential vault encrypts its entries with a key derived from the master password and stores the encrypted file beside the token. The vault must be unlocked in the web app before use. The browser panel and autofill require a compatible browser backend on `CODEX_WEB_BROWSER_SOCKET`; that backend is not included in this repository. Without it, the Browser panel and browser-backed vault fill actions are unavailable.

## Scheduled tasks

The web app includes its own scheduler and task panel. It can create interval, daily, weekly, and five-field cron schedules in an IANA timezone. Each task starts its own conversation on the first run and can either reuse that conversation later or start a fresh conversation on every run. Run history persists with the task and links to each run's conversation. If a reused conversation was archived, the scheduler unarchives it before the next run. Archiving a task retains its history; restoring it resumes its saved recurrence. Runs use the connected app-server and the task's selected working directory. Keep the web service and Codex daemon running for scheduled work to execute.

Scheduled runs cannot approve Codex actions. A scheduled run that needs approval is blocked and pauses its task. A supported `ask_user` request can wait in the app for up to 15 minutes; if nobody answers, the request is declined. The app can send an optional generic push notification to subscribed browsers. If the service restarts while a run may have started, that run is marked interrupted and the task is paused to avoid repeating work. Missed scheduled occurrences while the service is offline are skipped.

The web task panel works without registering MCP servers. If you want Codex itself to create and manage tasks through MCP, build the project and add the optional servers to your active Codex `config.toml` (commonly `~/.codex/config.toml`). Replace the example paths with the absolute path to this repository:

```toml
[mcp_servers.codex-scheduled-tasks]
command = "node"
args = ["/absolute/path/to/codex-daemon-web/dist/server/scheduled-tasks-mcp.js"]

[mcp_servers.user_interactions]
command = "node"
args = ["/absolute/path/to/codex-daemon-web/dist/server/user-interactions-mcp.js"]
```

The scheduled-task server exposes task-management tools. The `user_interactions` server exposes `ask_user`; its configured name must match for scheduled question handoff to work. Start or restart the Codex app-server after changing its MCP configuration. When customizing `XDG_STATE_HOME`, `CODEX_WEB_TOKEN_FILE`, or `CODEX_WEB_TASKS_SOCKET_FILE`, make sure the Codex-launched MCP process and web service use the same task socket path.

## Docker with a host app-server

Running the web server directly on the host is the simplest setup. In Docker, the container still does not start Codex; it needs access to the host daemon's Unix socket and persistent writable state. The following example is for a Linux host, assumes a Tailscale container named `tailscale`, and uses that container's network namespace so Tailscale Serve can reach the web server on loopback.

Resolve the active socket symlink and its physical directory on the host before building the image. These commands use task-specific shell variables and the Linux `getent` and `readlink -f` tools:

```sh
codex_home_path="${CODEX_HOME:-$(getent passwd "$(id -u)" | cut -d: -f6)/.codex}"
codex_socket_target="$(readlink -f "$codex_home_path/app-server-control/app-server-control.sock")"
test -S "$codex_socket_target" || { echo "The shared app-server socket is unavailable" >&2; exit 1; }
codex_socket_directory="$(dirname "$codex_socket_target")"
codex_socket_name="$(basename "$codex_socket_target")"
codex_uid="$(id -u)"
codex_gid="$(id -g)"
codex_user_home="$(getent passwd "$codex_uid" | cut -d: -f6)"
codex_state_directory="${XDG_STATE_HOME:-$codex_user_home/.local/state}/codex-daemon-web"
install -d -m 700 "$codex_state_directory"
```

Build and start the bridge with the same numeric UID and GID that own the host socket. The Dockerfile defaults to `1000:1000`; this example overrides that identity and bind-mounts a state directory owned by the host user.

```sh
docker build -t codex-daemon-web:local .
docker run -d \
  --name codex-daemon-web \
  --network container:tailscale \
  --user "$codex_uid:$codex_gid" \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m,mode=1777 \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --restart unless-stopped \
  --mount "type=bind,source=$codex_socket_directory,target=/daemon-sockets,readonly" \
  --mount "type=bind,source=$codex_state_directory,target=/var/lib/codex-daemon-web" \
  --env CODEX_APP_SERVER_URL="unix:///daemon-sockets/$codex_socket_name" \
  --env CODEX_WEB_TOKEN_FILE=/var/lib/codex-daemon-web/access-token \
  --env PUBLIC_URL=https://codex.example.ts.net \
  --env ALLOWED_ORIGINS=https://codex.example.ts.net \
  --env COOKIE_SECURE=true \
  codex-daemon-web:local
```

The socket directory is mounted read-only; do not mount the whole Codex home. Mounting the physical socket directory lets the container see a daemon restart that replaces the socket at the same path. Resolve the symlink again and recreate the container if the physical target directory or socket name changes. The separate state directory survives container replacement and contains the login token and other app state.

If Tailscale runs on the host rather than in a container, publish the container port only to host loopback and set `HOST=0.0.0.0` inside the container so Docker can forward to it. Keep the host-side published address at `127.0.0.1`; then point Tailscale Serve at that local port. Do not publish the service on a public interface.

## Protocol and limits

The bridge owns the app-server `initialize` handshake, then forwards JSON-RPC messages for each browser session. It caps WebSocket payloads at 1 MiB and rate-limits login attempts by direct peer address. The server must support the app-server protocol methods used by the web client; available settings and methods vary by Codex CLI version. See the [official app-server documentation](https://developers.openai.com/codex/app-server).
