import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
const meta = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'isolated-install-test', version: '1' },
  'io.modelcontextprotocol/clientCapabilities': {},
};

for (const host of ['claude', 'codex']) {
  test(
    `${host} catalog installs a standalone plugin outside the source checkout`,
    { timeout: 10000 },
    async (t) => {
      const catalog = await json(
        host === 'claude' ? '.claude-plugin/marketplace.json' : '.agents/plugins/marketplace.json',
      );
      assert.equal(catalog.name, 'x-plugin');
      const entry = catalog.plugins.find((p) => p.name === 'x-plugin');
      const source = host === 'claude' ? entry.source : entry.source.path;
      assert.equal(source, './plugins/x-plugin');
      const dir = await mkdtemp(join(tmpdir(), 'x plugin install '));
      const installed = join(dir, 'installed plugin');
      await cp(source, installed, { recursive: true });
      t.after(() => rm(dir, { recursive: true, force: true }));
      const manifest = await json(join(installed, `.${host}-plugin/plugin.json`));
      assert.equal(manifest.name, 'x-plugin');
      const config =
        host === 'claude'
          ? (await json(join(installed, '.mcp.json'))).mcpServers.x
          : manifest.mcpServers.x;
      assert.equal(config.command, 'node');
      const args = config.args.map((arg) => arg.replaceAll('${CLAUDE_PLUGIN_ROOT}', installed));
      // Match each host's path rules; run without global module search or project cwd.
      const cwd = config.cwd ? resolve(installed, config.cwd) : dir;
      const child = spawn(process.execPath, ['--no-global-search-paths', ...args], {
        cwd,
        env: { PATH: '', X_PLUGIN_CONFIG_DIR: join(dir, 'credentials'), X_ALLOW_WRITE: 'false' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      t.after(() => child.kill());
      let stderr = '';
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      const lines = createInterface({ input: child.stdout });
      t.after(() => lines.close());
      const pending = new Map();
      child.on('error', (error) => {
        for (const waiter of pending.values()) waiter.reject(error);
      });
      child.on('exit', () => {
        for (const waiter of pending.values())
          waiter.reject(new Error(`Runtime exited: ${stderr}`));
      });
      lines.on('line', (line) => {
        try {
          const message = JSON.parse(line);
          pending.get(message.id)?.resolve(message);
        } catch (error) {
          for (const waiter of pending.values()) waiter.reject(error);
        }
      });
      let id = 0;
      async function call(method, params = {}) {
        const key = ++id;
        const deferred = Promise.withResolvers();
        pending.set(key, deferred);
        const timer = setTimeout(
          () => deferred.reject(new Error(`No MCP response: ${stderr}`)),
          5000,
        );
        child.stdin.write(
          JSON.stringify({ jsonrpc: '2.0', id: key, method, params: { _meta: meta, ...params } }) +
            '\n',
        );
        try {
          return await deferred.promise;
        } finally {
          clearTimeout(timer);
          pending.delete(key);
        }
      }
      const list = await call('tools/list');
      assert.equal(list.result.tools.length, 7);
      assert.ok(!list.result.tools.some((tool) => tool.name === 'x_send_dm'));
      const missingAuth = await call('tools/call', { name: 'x_get_me', arguments: {} });
      assert.equal(missingAuth.result.isError, true);
      assert.match(JSON.stringify(missingAuth), /auth login/);
      assert.equal(stderr, '');
    },
  );
}
