# X Plugin

Search posts, read DMs, and draft replies. Node.js 24+ must be available to your agent. The runtime and dependencies are bundled; no npm install, build, or global command is needed.

## Connect your account

Ask your agent to help connect X. It should locate this installed plugin directory and run the bundled CLI on your machine:

```sh
node "/absolute/path/to/installed/x-plugin/runtime/x-plugin.cjs" --help
```

Create an X developer app with OAuth 2.0 enabled as a **Native App**. Register the exact callback `http://127.0.0.1:8787/callback`. Then run:

```sh
X_CLIENT_ID='your-native-app-client-id' node "/absolute/path/to/installed/x-plugin/runtime/x-plugin.cjs" auth login
```

On PowerShell, set `$env:X_CLIENT_ID = 'your-native-app-client-id'` first, then run the same `node` command. Open the printed authorization URL in a browser on the same machine. Complete authorization yourself; do not paste tokens or callback URLs into the agent chat. Ask the agent to call `x_get_me` afterward to verify the account.

The agent can resolve the runtime from this README's directory, or as `../../runtime/x-plugin.cjs` relative to `skills/x-dms/`. Preserve the installed plugin directory and quote paths containing spaces. Never search for or read credential files to establish connection status; use `auth status` or `x_get_me`.

Credentials live outside the installed plugin cache, so plugin updates retain the connection. Run the bundled CLI with `auth logout` to remove local credentials; revoke app access in X settings to invalidate tokens. Removing the plugin alone does not revoke X authorization.

## Optional sending

Sending is disabled by default. Only when requested, run `auth login --write` and configure the host's MCP process with `X_ALLOW_WRITE=true`, then restart it. Each send still needs the user's authorization. If a send times out, check the conversation before retrying.

## Limits

An X developer app and API access are still required. Standard DM lookup covers up to 30 days; recent post search covers seven days. This plugin targets local Claude Code and Codex clients, not a hosted ChatGPT connector. Real X login and actual host sessions still require live testing.
