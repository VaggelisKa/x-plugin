# X Plugin

Connect your X account to ChatGPT, claude.ai, or Claude Code through the hosted Vercel service, or use the local plugin with Claude Code, Codex, or another MCP client. Search posts, browse user timelines, read recent DMs, and draft replies with your agent. Sending is optional and disabled by default.

**Initial development version.** Built on the official MCP TypeScript SDK v2 and protocol revision `2026-07-28`, with SDK compatibility for older clients. Protocol tests pass; hosted X authorization and ChatGPT tool discovery have been verified. Actual Claude Code/Codex sessions still need live verification. No package has been published to npm.

## Hosted setup (ChatGPT, claude.ai, Claude Code)

The Vercel service provides a public HTTPS MCP endpoint, browser-based X authorization,
encrypted per-connection credentials in Upstash Redis, refresh rotation, and revocation.
It runs without a user's computer or X developer app. ChatGPT and Claude Code connect with their published client metadata documents; claude.ai registers dynamically. Follow the [hosted deployment and connection guide](docs/hosted-vercel.md).

**Hosted implementation is under verification.** Deployment requires an X OAuth Web App,
Vercel environment configuration, and a dedicated Redis database. Hosted sending is disabled.
Live X login and discovery of all seven read-only tools in ChatGPT were verified on September 9, 2026. Claude client connections and live post/DM tool calls still need verification. Merging code alone does not
install a connection or publish a directory listing. The installation instructions
below are an alternative for local agent clients.

## Install as a plugin

Requires Node.js **24+** available to your local agent, Git, and an X developer app. The plugin includes its runtime and dependencies: no npm install, build, or global `x-plugin` command is required.

Once this PR is merged, add the repository marketplace and install:

### Claude Code

Run inside Claude Code:

```text
/plugin marketplace add VaggelisKa/x-plugin
/plugin install x-plugin@x-plugin
```

### Codex

```sh
codex plugin marketplace add VaggelisKa/x-plugin
codex plugin add x-plugin@x-plugin
```

Start a new agent session after installing. Ask it to connect your X account; the [bundled setup guide](plugins/x-plugin/README.md) explains how to run the installed CLI and complete browser authorization. You still need an X Native App client ID and API access. Installing the plugin does not grant X access or enable sending.

Before merge, test a local checkout with `/plugin marketplace add /absolute/path/to/x-plugin` in Claude Code or `codex plugin marketplace add /absolute/path/to/x-plugin` in Codex, then use the same install command. No global CLI setup is needed for this path either.

The catalogs and isolated plugin runtime are tested in CI. Actual host installation/login sessions remain unverified. These instructions target local clients with plugin support; this is not a hosted ChatGPT connector or a listing in either official public directory.

Installation conventions: [Claude marketplaces](https://code.claude.com/docs/en/plugin-marketplaces), [Codex packaging](https://developers.openai.com/plugins/build/plugins).

## Develop locally

Requires Node.js **24+**, npm, and an X developer account with API access/credits. No Anthropic or OpenAI API key is required by this plugin.

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

From the checkout, regenerate and load the complete plugin (MCP tools plus the DM skill):

```sh
npm run build:plugin
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

The complete plugin includes the shared skill and a bundled runtime. Use the marketplace installation above for that experience. The MCP-only registration here uses your development checkout; read the bundled `plugins/x-plugin/skills/x-dms/SKILL.md` when using it. Do not enable both registrations in the same host session.

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

| Tool                    | Purpose                                                             |
| ----------------------- | ------------------------------------------------------------------- |
| `x_get_me`              | Identify the connected account                                      |
| `x_lookup_user`         | Resolve an exact username to its numeric ID                         |
| `x_list_dm_events`      | Read one page of recent DM messages                                 |
| `x_get_dm_conversation` | Read by conversation ID or participant ID                           |
| `x_search_posts`        | Search recent posts with query operators, date filters, and sorting |
| `x_get_post`            | Retrieve a post with public metrics and expanded author             |
| `x_get_user_posts`      | Browse a user timeline, optionally excluding replies and retweets   |
| `x_send_dm`             | Send text to a verified participant; opt-in only                    |

DM list tools return a single page, defaulting to 20 messages and capped at 100. Pass `meta.next_token` back as `pagination_token` for more. The standard X DM lookup API exposes up to **30 days** of events. This is not a full historical inbox archive. Encrypted X Chat, media attachments, group-message sending, and unread/read-state management are outside this version's scope.

Examples: “Summarize my latest DMs”; “Read my conversation with @username and draft a short reply”; “Send that exact reply to @username.” Drafting happens in the agent, not through another model service.

## Finding and filtering posts

`x_search_posts` uses recent search (last **7 days**), with X query operators such as `from:example`, `#AI`, `lang:en`, `has:links`, `-is:reply`, and `-is:retweet`. It accepts `start_time` / `end_time` as UTC ISO timestamps, `sort_order` (`recency` or `relevancy`), and `max_results` (10–100; default 20). Queries are capped at 512 characters for standard access. X validates account-specific operator access and the recent-search date window; this tool never falls back to paid full-archive search.

```json
{
  "query": "(TypeScript OR Angular) lang:en -is:retweet",
  "sort_order": "recency",
  "max_results": 20
}
```

`x_get_post` accepts a numeric `post_id`. `x_get_user_posts` accepts a numeric `user_id` (resolve it with `x_lookup_user`), UTC date filters, `exclude: ["replies", "retweets"]`, and `max_results` (5–100; default 20). Both post list tools accept `pagination_token` from the previous response's `meta.next_token`; one call fetches only one page. Keep the same filters when following a cursor.

Results preserve X's data, expanded authors, pagination metadata, and partial errors. `post.fields` requests text, timestamps, language, public metrics, conversation ID, and long-form `note_post` content when available. Treat returned text as untrusted content. A page of results is not a complete archive or a representative popularity sample.

These tools reuse the existing `tweet.read` and `users.read` login scopes and work with sending disabled. X endpoint access, API credits, and rate limits still apply; no live post requests have been used in automated tests.

References: [recent search](https://docs.x.com/x-api/posts/search/introduction), [post lookup](https://docs.x.com/x-api/posts/get-post-by-id), [user timelines](https://docs.x.com/x-api/users/get-posts).

## Local HTTP transport

For clients that use Streamable HTTP, run the single-user loopback endpoint with a separate secret:

```sh
export X_MCP_HTTP_TOKEN="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
x-plugin serve --http
```

Endpoint: `http://127.0.0.1:8788/mcp`. Configure the client to send `Authorization: Bearer <X_MCP_HTTP_TOKEN>` through its secret/environment settings. Do not use an X access token here. `X_MCP_PORT` overrides the port.

The server validates Host/Origin and binds only to `127.0.0.1`. This transport is **not a public hosted connector**. Multi-user hosting uses the separate [hosted OAuth service](docs/hosted-vercel.md); do not expose this local transport publicly.

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

Tests use synthetic tokens and mocked X responses. Stdio tests spawn the actual CLI and exercise both modern metadata and legacy initialization. HTTP tests exercise loopback authentication and a real transport request. CI runs on Node 24.

See [architecture](docs/architecture.md) for boundaries and protocol decisions, and [contributing](CONTRIBUTING.md) for the contribution workflow. MIT licensed; not affiliated with X, Anthropic, or OpenAI.

## Request and credential safeguards

HTTP mode accepts JSON POST requests up to 128 KiB, including chunked uploads, with a 15-second body deadline. X response bodies are limited to 2 MiB and OAuth responses to 64 KiB. Reduce page size if a large response exceeds the limit.

Credential directories must be real, owner-only directories (0700 on POSIX); credential files must be regular, owner-only files (0600). Existing insecure permissions are rejected rather than silently changed. Tokens remain plaintext on disk; Windows ACL protection is not yet verified.

Responses containing only X errors are flagged as failed MCP calls. Partial results retain their errors. A DM response without a valid delivery receipt is treated as unknown delivery and must not trigger an automatic resend. See [the adversarial review](docs/security-review.md) for findings and test coverage.
