# Architecture

X Plugin is a host-neutral MCP server and a shared DM workflow skill, with separate Claude Code and Codex manifests. Local clients use the CLI; ChatGPT, claude.ai, and Claude Code can instead use the separate hosted OAuth service described in [hosted deployment](hosted-vercel.md). The hosted service is read-only and awaits live connection verification.

## Boundaries

| Module              | Responsibility                                                                  |
| ------------------- | ------------------------------------------------------------------------------- |
| `src/auth.ts`       | OAuth PKCE login, loopback callback, credential persistence, serialized refresh |
| `src/x-client.ts`   | X API endpoints, bounded pagination, write gating, redacted errors              |
| `src/server.ts`     | Tool schemas, annotations, structured results; no transport sessions            |
| `src/http.ts`       | Authenticated single-user loopback HTTP adapter                                 |
| `src/cli.ts`        | Explicit auth commands and transport selection                                  |
| `plugins/x-plugin/` | Host manifests and shared DM skill                                              |

Tool handlers accept explicit IDs/cursors. They do not depend on conversation state in the transport. Credential persistence is application state shared across host processes, independent of MCP sessions.

## MCP revision and compatibility

Use official `@modelcontextprotocol/server` and `@modelcontextprotocol/node` v2. The SDK [documents v2 as implementing revision 2026-07-28](https://github.com/modelcontextprotocol/typescript-sdk/tree/main/packages/server). The protocol uses date-based versions; “2.0” identifies the SDK release line here.

`serveStdio(factory, { legacy: 'serve' })` delegates modern/legacy selection to the SDK. `createMcpHandler(factory)` provides stateless modern HTTP with its SDK-managed stateless legacy fallback. Do not implement a custom JSON-RPC protocol or hide state in a server session. Shared server factories register the same tools for both transports.

No sampling, model API dependency, background polling, or task extension is needed for this version. Tool catalogs are fixed per process configuration. DM content is untrusted data and must not be interpreted as instructions.

## Post tools

`src/posts.ts` defines shared Zod schemas used by the MCP layer and X client, so direct client calls also validate filters before network access. Recent search maps the public `pagination_token` to X’s `next_token`; user timelines retain `pagination_token`. Both return one bounded page. Search syntax is passed through unchanged, with a standard-access 512-character limit. These read-only tools reuse existing OAuth read scopes.

## Authentication and sending

X Native App OAuth uses S256 PKCE and random state, a five-minute login deadline, and exact loopback callback matching. Read access requests `tweet.read users.read dm.read offline.access`; `--write` adds `dm.write`. The CLI, not an MCP tool, handles login so credentials stay outside model context.

Store tokens atomically with 0600 permissions on POSIX. Refresh is serialized within a process and guarded across processes. Auth busy errors are retryable after the other operation finishes; do not silently delete a live lock. Native keychain storage and crash recovery are future improvements.

MCP HTTP authentication uses a distinct user-configured secret. It is not X authorization, OAuth token passthrough, or an implementation of public MCP OAuth. The hosted service in `src/hosted/` provides separate resource discovery, allowlisted client authorization (ChatGPT and Claude Code metadata documents, public-client dynamic registration for claude.ai and loopback agents), and isolated encrypted token storage. It does not expose the loopback adapter.

Sending is absent from the default tool catalog and rejected by the client unless explicitly enabled. The host handles user authorization; instructions alone are not an enforceable approval UI. Sending is annotated non-idempotent. No request is automatically retried, especially a send with unknown delivery.

## Verification and remaining work

Automated tests cover X request shapes, cursor handling, error redaction, refresh rotation, local OAuth state checks, write gating, and modern/legacy transport behavior. Actual Claude Code and Codex sessions, real X OAuth/API access, encrypted X Chat behavior, Windows credential protection, and marketplace installation remain unverified.

Next milestones: live account smoke test, host-specific installation/end-to-end checks, portable credential storage, release ownership, then public HTTP OAuth. Do not describe the package as published or fully client-verified before those gates pass.

Sources: [MCP release](https://blog.modelcontextprotocol.io/posts/2026-07-28/), [X OAuth](https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code), [X DM lookup](https://docs.x.com/x-api/direct-messages/lookup/introduction), [Claude plugins](https://code.claude.com/docs/en/plugins-reference), [Codex MCP](https://developers.openai.com/codex/mcp/).

## Repository installation

The repository has a Claude catalog at `.claude-plugin/marketplace.json` and a Codex catalog at `.agents/plugins/marketplace.json`. Both point at `plugins/x-plugin`. `npm run build:plugin` regenerates catalogs/manifests and bundles the CLI and runtime dependencies with pinned esbuild into a tracked CommonJS file. CommonJS makes bundled dynamic Node builtin imports work without external package resolution. The runtime checks Node 24 before loading dependencies. The bundle includes full dependency license/notice files, and build verification rejects external npm imports.

Claude resolves `${CLAUDE_PLUGIN_ROOT}` in `.mcp.json`. Codex uses its inline `mcpServers` object with `cwd: "."`, which its loader resolves relative to the installed plugin root. Keeping the configurations separate avoids assuming Claude's variable interpolation works in Codex. Neither startup path installs packages, builds code, writes into the plugin cache, or requires `npm link`.

CI rebuilds the tracked artifacts and checks for drift, then copies the plugin into an unrelated temporary directory (including spaces in its path) and starts each configured MCP command with empty PATH and global module search disabled. These tests exercise the bundle and documented host path semantics, not a real Claude/Codex installation. OAuth still runs explicitly in the local CLI, outside MCP; plugin discovery must not trigger login.
