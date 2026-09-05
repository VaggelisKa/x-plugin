#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { CredentialStore, login, tokenProvider } from './auth.js';
import { XClient } from './x-client.js';
import { createServer } from './server.js';
import { startHttp } from './http.js';

async function main() {
  const args = process.argv.slice(2);
  const store = new CredentialStore();
  if (args.length === 0 || args[0] === 'help' || args[0] === '--help') {
    process.stdout.write(
      `x-plugin (Node.js >=24)\n\nCommands:\n  auth login [--write]   Connect an X Native App using X_CLIENT_ID\n  auth status           Show connection status without credentials\n  auth logout           Remove local credentials (revoke in X settings separately)\n  serve                 Serve MCP over stdio\n  serve --http          Serve MCP at http://127.0.0.1:8788/mcp\n\nEnvironment:\n  X_CLIENT_ID           Native App OAuth client ID for login\n  X_ALLOW_WRITE=true    Expose sending tools (requires login --write)\n  X_PLUGIN_CONFIG_DIR   Override credential directory\n  X_MCP_HTTP_TOKEN      Separate 32+ character secret for HTTP mode\n  X_MCP_PORT            HTTP port (default 8788)\n`,
    );
    return;
  }
  if (args[0] === 'auth') {
    if (args[1] === 'login' && args.length <= 3 && (!args[2] || args[2] === '--write')) {
      if (!process.env.X_CLIENT_ID)
        throw new Error('Set X_CLIENT_ID to your X Native App OAuth client ID.');
      await login(store, process.env.X_CLIENT_ID, args[2] === '--write');
      process.stderr.write('Connected to X.\n');
    } else if (args[1] === 'status' && args.length === 2) {
      const c = await store.read();
      process.stdout.write(
        JSON.stringify({
          connected: true,
          expired: c.expiresAt <= Date.now(),
          refresh_available: Boolean(c.refreshToken),
          scopes: c.scope.split(' '),
        }) + '\n',
      );
    } else if (args[1] === 'logout' && args.length === 2) {
      await store.locked(() => store.clear());
      process.stderr.write(
        'Local credentials removed. Revoke app access in X settings to invalidate tokens.\n',
      );
    } else throw new Error('Unknown auth command. Run x-plugin --help.');
    return;
  }
  if (args[0] !== 'serve' || args.length > 2 || (args[1] && args[1] !== '--http'))
    throw new Error('Unknown command. Run x-plugin --help.');
  const client = new XClient(tokenProvider(store), process.env.X_ALLOW_WRITE === 'true');
  if (args[1] === '--http') {
    const server = startHttp(
      client,
      process.env.X_MCP_HTTP_TOKEN ?? '',
      Number(process.env.X_MCP_PORT ?? 8788),
    );
    server.on('error', () => {
      process.stderr.write('HTTP server failed to start. Check port availability.\n');
      process.exitCode = 1;
    });
    server.on('listening', () =>
      process.stderr.write('X MCP HTTP server listening on loopback.\n'),
    );
    const close = () => {
      server.close();
      server.closeAllConnections();
    };
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
  } else {
    const handle = serveStdio(() => createServer(client), {
      legacy: 'serve',
      onerror: () => process.stderr.write('MCP transport error.\n'),
    });
    process.once('SIGINT', () => void handle.close());
    process.once('SIGTERM', () => void handle.close());
  }
}
main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Command failed.'}\n`);
  process.exitCode = 1;
});
