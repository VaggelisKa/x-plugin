import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { XClient } from '../dist/x-client.js';
import { startHttp } from '../dist/http.js';

const meta = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'x-plugin-test', version: '1.0.0' },
  'io.modelcontextprotocol/clientCapabilities': {},
};
function processClient(t, write = false) {
  const child = spawn(process.execPath, ['dist/cli.js', 'serve'], {
    env: {
      ...process.env,
      X_ALLOW_WRITE: String(write),
      X_PLUGIN_CONFIG_DIR: '/nonexistent/x-plugin-test',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (b) => {
    stderr += b;
  });
  t.after(() => child.kill());
  const lines = createInterface({ input: child.stdout });
  const waiters = new Map();
  lines.on('line', (line) => {
    const msg = JSON.parse(line);
    const resolve = waiters.get(msg.id);
    if (resolve) {
      waiters.delete(msg.id);
      resolve(msg);
    }
  });
  let seq = 0;
  return {
    call(method, params) {
      const id = ++seq;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out: ${stderr}`)), 5000);
        waiters.set(id, (msg) => {
          clearTimeout(timer);
          resolve(msg);
        });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
    },
    notify(method) {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n');
    },
  };
}

test('modern stdio discovers read-only tools and returns a safe missing-auth error', async (t) => {
  const c = processClient(t);
  const list = await c.call('tools/list', { _meta: meta });
  assert.ok(list.result, JSON.stringify(list));
  assert.equal(list.result.tools.length, 7);
  assert.ok(!list.result.tools.some((x) => x.name === 'x_send_dm'));
  const result = await c.call('tools/call', { _meta: meta, name: 'x_get_me', arguments: {} });
  assert.equal(result.result.isError, true);
  assert.match(JSON.stringify(result), /auth login/);
});

test('legacy stdio initialization works through SDK compatibility', async (t) => {
  const c = processClient(t, true);
  const init = await c.call('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'legacy-test', version: '1' },
  });
  assert.equal(init.result.protocolVersion, '2025-11-25');
  c.notify('notifications/initialized');
  const list = await c.call('tools/list', {});
  assert.ok(
    list.result.tools.some((x) => x.name === 'x_send_dm' && x.annotations.idempotentHint === false),
  );
});

test('HTTP requires separate authentication, rejects hostile origins, and serves stateless modern calls', async (t) => {
  let calls = 0;
  const client = new XClient(
    async () => 'fake-x-token',
    false,
    async () => {
      calls++;
      return Response.json({ data: { id: '123', username: 'test' } });
    },
  );
  const secret = 's'.repeat(40);
  const server = startHttp(client, secret, 0);
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  assert.equal((await fetch(url, { method: 'POST' })).status, 401);
  assert.equal(
    (
      await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${secret}`, Origin: 'https://evil.example' },
      })
    ).status,
    403,
  );
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2026-07-28',
      'Mcp-Method': 'tools/call',
      'Mcp-Name': 'x_get_me',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { _meta: meta, name: 'x_get_me', arguments: {} },
    }),
  });
  const body = await response.text();
  assert.equal(response.status, 200, body);
  assert.match(body, /test/);
  assert.equal(calls, 1);
  assert.equal(response.headers.get('Mcp-Session-Id'), null);
});
