# X Plugin

Connect your X account to Claude Code, Codex, or another MCP client. Read recent DMs, review conversations, and draft replies with your agent. Sending is optional and disabled by default.

**Initial development version.** Built on the official MCP TypeScript SDK v2 and protocol revision `2026-07-28`, with SDK compatibility for older clients. Protocol tests pass; live X authorization and actual Claude Code/Codex sessions have not yet been verified. No package has been published to npm.

## Get started

Requires Node.js **22.18+**, npm, and an X developer account with API access/credits. No Anthropic or OpenAI API key is required by this plugin.

```sh
git clone https://github.com/VaggelisKa/x-plugin.git
cd x-plugin
npm ci
npm run build
npm link
x-plugin --help
```

`npm link` installs the `x-plugin` command from your checkout. Keep that checkout in place. If your agent cannot find the command, use its absolute path or configure `node /absolute/path/x-plugin/dist/cli.js serve` instead.

### Connect X

1. Create an app in the [X Developer Console](https://developer.x.com/).
2. Enable OAuth 2.0 and choose **Native App** (public client). Confidential/web apps with client secrets are not supported in this version.
3. Register this exact callback URL: `http://127.0.0.1:8787/callback`.
4. Set the app's OAuth **Client ID** in your terminal and run login:

```sh
export X_CLIENT_ID='your-native-app-client-id'
x-plugin auth login
```

Open the printed URL in a browser on the **same machine**. Approve access; the local callback completes login. Do not paste tokens or callback URLs into an agent conversation.

```sh
x-plugin auth status
```

Status reports stored credentials and expiry, not a live connectivity check. Ask your agent to call `x_get_me` to verify the account.

### Claude Code

From the checkout, load the complete plugin (MCP tools plus the DM skill):

```sh
claude --plugin-dir ./plugins/x-plugin
```

Alternatively, register only the MCP server:

```sh
claude mcp add --transport stdio x -- x-plugin serve
```

Use one method to avoid duplicate tools. The complete plugin includes guidance for recipient verification, pagination, drafting, and uncertain delivery.

### Codex

Register the MCP server:

```sh
codex mcp add x -- x-plugin serve
```

Equivalent `config.toml` entry:

```toml
[mcp_servers.x]
command = "x-plugin"
args = ["serve"]
```

The complete Codex plugin manifest is in `plugins/x-plugin/.codex-plugin/plugin.json`, with the shared skill alongside it. It is prepared for plugin import; marketplace installation is not configured or tested in this first version. MCP registration above works independently of marketplace packaging. Read the bundled `plugins/x-plugin/skills/x-dms/SKILL.md` when using only the MCP registration.

### Enable sending

Grant the additional X scope, then start the agent/server with writes enabled:

```sh
x-plugin auth login --write
export X_ALLOW_WRITE=true
claude --plugin-dir ./plugins/x-plugin
```

For Codex, explicitly pass the setting in its MCP configuration:

```toml
[mcp_servers.x]
command = "x-plugin"
args = ["serve"]

[mcp_servers.x.env]
X_ALLOW_WRITE = "true"
```

Both the OAuth `dm.write` grant and the server setting are required. The plugin's send tool is absent in read-only mode, and the X client checks the setting again before sending. Host approval settings and the user's authorization control actual sends; the environment flag does not itself constitute per-message approval.

## Tools

| Tool                    | Purpose                                          |
| ----------------------- | ------------------------------------------------ |
| `x_get_me`              | Identify the connected account                   |
| `x_lookup_user`         | Resolve an exact username to its numeric ID      |
| `x_list_dm_events`      | Read one page of recent DM messages              |
| `x_get_dm_conversation` | Read by conversation ID or participant ID        |
| `x_send_dm`             | Send text to a verified participant; opt-in only |

List tools return a single page, defaulting to 20 messages and capped at 100. Pass `meta.next_token` back as `pagination_token` for more. The standard X DM lookup API exposes up to **30 days** of events. This is not a full historical inbox archive. Encrypted X Chat, media attachments, group-message sending, and unread/read-state management are outside this version's scope.

Examples: “Summarize my latest DMs”; “Read my conversation with @username and draft a short reply”; “Send that exact reply to @username.” Drafting happens in the agent, not through another model service.

## Local HTTP transport

For clients that use Streamable HTTP, run the single-user loopback endpoint with a separate secret:

```sh
export X_MCP_HTTP_TOKEN="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
x-plugin serve --http
```

Endpoint: `http://127.0.0.1:8788/mcp`. Configure the client to send `Authorization: Bearer <X_MCP_HTTP_TOKEN>` through its secret/environment settings. Do not use an X access token here. `X_MCP_PORT` overrides the port.

The server validates Host/Origin and binds only to `127.0.0.1`. This transport is **not a public hosted connector**. Multi-user hosting and browser-based ChatGPT/Claude connections require a separate MCP OAuth resource server and per-user token storage, planned as follow-up work.

## Privacy and credentials

- X API traffic goes directly to `api.x.com`; login opens `x.com`. Retrieved messages are passed to the agent you chose, whose data policies apply.
- The server does not persist DM bodies or log credentials/message contents. It has no analytics or telemetry.
- Credentials are stored in `~/.config/x-plugin/credentials.json`. Set `X_PLUGIN_CONFIG_DIR` to isolate another account. Use the same directory in login and the agent's MCP environment.
- Credentials are plaintext with owner-only file permissions on POSIX, not encrypted keychain entries. On Windows, directory ACLs determine protection. Keep the directory private and outside the checkout.
- Refresh tokens rotate through an atomic file update. A directory lock prevents concurrent rotation by Claude and Codex. If a process crashes while holding the lock, stop other plugin processes and remove `auth.lock` from that config directory before retrying.
- `x-plugin auth logout` deletes local credentials. Revoke the app in X settings to invalidate issued tokens remotely.
- A timed-out send might have reached X. The plugin never retries requests automatically; check the conversation before resending.

## Development

```sh
npm run check
npm run format:check
npm pack --dry-run
```

Tests use synthetic tokens and mocked X responses. Stdio tests spawn the actual CLI and exercise both modern metadata and legacy initialization. HTTP tests exercise loopback authentication and a real transport request. CI runs on Node 22 and 24.

See [architecture](docs/architecture.md) for boundaries and protocol decisions, and [contributing](CONTRIBUTING.md) for the contribution workflow. MIT licensed; not affiliated with X, Anthropic, or OpenAI.
