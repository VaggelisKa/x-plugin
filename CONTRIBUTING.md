# Contributing

Use Node.js 24 (`nvm use`) and run `npm ci`, `npm run check`, and `npm run format:check` before opening a pull request. Tests must use synthetic credentials and mocked X responses; live integration testing is opt-in and must never run in public CI.

Keep X API logic independent from MCP transports. Keep changes compatible with the shared Claude Code/Codex plugin. Generate manifests with `node scripts/configure-plugins.mjs` after changing metadata.

Never commit credentials, captured DMs, private callback URLs, or account exports. Reports of uncertain DM delivery must not trigger automatic resend logic.

The npm package is intentionally private until naming/ownership and release verification are completed. Opening a pull request does not publish the package or contact any X user.
