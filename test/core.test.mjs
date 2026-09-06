import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { XClient } from '../dist/x-client.js';
import { CredentialStore, authorization, tokenProvider, login } from '../dist/auth.js';

const fixture = {
  clientId: 'test-client',
  accessToken: 'private-token',
  refreshToken: 'private-refresh',
  scope: 'dm.read',
  expiresAt: 0,
};
async function storeFor(t) {
  const dir = await mkdtemp(join(tmpdir(), 'x-plugin-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return new CredentialStore(dir);
}

test('PKCE uses S256, unique state, and read-only scopes by default', () => {
  const a = authorization('client', 'http://127.0.0.1:8787/callback');
  const p = new URL(a.url).searchParams;
  assert.equal(
    p.get('code_challenge'),
    createHash('sha256').update(a.verifier).digest('base64url'),
  );
  assert.equal(p.get('code_challenge_method'), 'S256');
  assert.ok(!p.get('scope').includes('dm.write'));
  assert.notEqual(a.state, authorization('client', 'http://127.0.0.1:8787/callback').state);
  assert.ok(
    new URL(authorization('client', 'http://127.0.0.1:8787/callback', true).url).searchParams
      .get('scope')
      .includes('dm.write'),
  );
});

test('refresh is serialized and rotated tokens persist with restricted permissions', async (t) => {
  const store = await storeFor(t);
  await store.write(fixture);
  let calls = 0;
  const getToken = tokenProvider(store, async (_url, init) => {
    calls++;
    assert.equal(init.body.get('refresh_token'), 'private-refresh');
    await new Promise((resolve) => setTimeout(resolve, 10));
    return Response.json({
      access_token: 'new-token',
      refresh_token: 'rotated',
      token_type: 'bearer',
      expires_in: 7200,
    });
  });
  assert.deepEqual(await Promise.all([getToken(), getToken(), getToken()]), [
    'new-token',
    'new-token',
    'new-token',
  ]);
  assert.equal(calls, 1);
  assert.equal((await store.read()).refreshToken, 'rotated');
  assert.equal((await store.read()).scope, 'dm.read');
  if (process.platform !== 'win32')
    assert.equal((await stat(join(store.directory, 'credentials.json'))).mode & 0o777, 0o600);
});

test('independent credential stores cannot simultaneously rotate a refresh token', async (t) => {
  const store = await storeFor(t);
  await store.locked(async () => {
    await assert.rejects(
      new CredentialStore(store.directory).locked(async () => {}),
      /Another authentication/,
    );
  });
  await store.locked(async () => {});
});

test('OAuth callback rejects wrong state, then exchanges the valid code once', async (t) => {
  const store = await storeFor(t);
  let notify;
  const ready = new Promise((resolve) => {
    notify = resolve;
  });
  let calls = 0;
  const done = login(
    store,
    'test-client',
    false,
    async (_url, init) => {
      calls++;
      assert.equal(init.body.get('code'), 'test-code');
      assert.equal(init.body.get('grant_type'), 'authorization_code');
      return Response.json({
        access_token: 'connected-token',
        token_type: 'bearer',
        expires_in: 7200,
        scope: 'dm.read',
      });
    },
    notify,
  );
  const authUrl = new URL(await ready);
  const { request: rawRequest } = await import('node:http');
  const malformed = await new Promise((resolve, reject) => {
    const req = rawRequest({ hostname: '127.0.0.1', port: 8787, path: 'http://[' }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(malformed, 400);
  const callback = new URL('http://127.0.0.1:8787/callback?code=test-code&state=wrong');
  assert.equal((await fetch(callback)).status, 400);
  assert.equal(calls, 0);
  callback.searchParams.set('state', authUrl.searchParams.get('state'));
  const response = await fetch(callback);
  assert.equal(response.status, 200);
  await response.text();
  await done;
  assert.equal(calls, 1);
  assert.equal((await store.read()).accessToken, 'connected-token');
});

test('pagination is bounded and passes through the next cursor', async () => {
  let calls = 0;
  const client = new XClient(
    async () => 'token',
    false,
    async (url, init) => {
      calls++;
      assert.equal(url.origin, 'https://api.x.com');
      assert.equal(url.searchParams.get('pagination_token'), 'opaque+/=');
      assert.equal(url.searchParams.get('max_results'), '10');
      assert.equal(init.headers.Authorization, 'Bearer token');
      assert.equal(init.redirect, 'error');
      return Response.json({ data: [{ id: '123', text: 'hello' }], meta: { next_token: 'next' } });
    },
  );
  assert.equal(
    (await client.messages({ max_results: 10, pagination_token: 'opaque+/=' })).meta.next_token,
    'next',
  );
  assert.equal(calls, 1);
  assert.throws(() => client.messages({ max_results: 101 }), /1–100/);
  assert.throws(() => client.messages({}, '../bad'), /Invalid/);
});

test('sending requires write configuration and preserves exact text', async () => {
  let calls = 0;
  const request = async (url, init) => {
    calls++;
    assert.equal(url.pathname, '/2/dm_conversations/with/123/messages');
    assert.deepEqual(JSON.parse(init.body), { text: ' hello\n' });
    return Response.json({ data: { dm_event_id: '456' } });
  };
  await assert.rejects(
    new XClient(async () => 'token', false, request).send('123', 'hello'),
    /disabled/,
  );
  assert.equal(calls, 0);
  await new XClient(async () => 'token', true, request).send('123', ' hello\n');
  assert.equal(calls, 1);
});

test('send network failures are ambiguous and never retried', async () => {
  let calls = 0;
  const client = new XClient(
    async () => 'token',
    true,
    async () => {
      calls++;
      throw new Error('private-token');
    },
  );
  await assert.rejects(
    client.send('123', 'hello'),
    (e) => /Delivery is unknown/.test(e.message) && !e.message.includes('private-token'),
  );
  assert.equal(calls, 1);
});

test('rate-limit errors preserve retry information without reflecting private response bodies', async () => {
  const client = new XClient(
    async () => 'token',
    false,
    async () =>
      new Response('secret message body', { status: 429, headers: { 'retry-after': '60' } }),
  );
  await assert.rejects(
    client.me(),
    (e) => e.status === 429 && e.retryAfter === '60' && !e.message.includes('secret'),
  );
});

test('credential store rejects insecure permissions, symlinks, and malformed tokens', async (t) => {
  const { chmod, symlink, unlink, writeFile } = await import('node:fs/promises');
  const store = await storeFor(t);
  await store.write(fixture);
  const path = join(store.directory, 'credentials.json');
  if (process.platform !== 'win32') {
    await chmod(path, 0o644);
    await assert.rejects(store.read(), /insecure/);
    await chmod(path, 0o600);
    await chmod(store.directory, 0o755);
    await assert.rejects(store.read(), /secure credential directory/);
    await chmod(store.directory, 0o700);
    await unlink(path);
    await writeFile(join(store.directory, 'target'), JSON.stringify(fixture), { mode: 0o600 });
    await symlink(join(store.directory, 'target'), path);
    await assert.rejects(store.read(), /credentials/);
    await unlink(path);
  }
  await writeFile(path, JSON.stringify({ ...fixture, refreshToken: 123 }), { mode: 0o600 });
  await assert.rejects(store.read(), /Invalid/);
});

test('OAuth releases its lock when authorization display fails', async (t) => {
  const store = await storeFor(t);
  await assert.rejects(
    login(store, 'client', false, fetch, () => {
      throw new Error('private');
    }),
    /Could not open/,
  );
  await store.locked(async () => {});
});

test(
  'OAuth completes even if browser disconnects during token exchange',
  { timeout: 5000 },
  async (t) => {
    const { get } = await import('node:http');
    const store = await storeFor(t);
    const ready = Promise.withResolvers();
    const exchange = Promise.withResolvers();
    const started = Promise.withResolvers();
    const done = login(
      store,
      'client',
      false,
      async () => {
        started.resolve();
        return exchange.promise;
      },
      ready.resolve,
    );
    const state = new URL(await ready.promise).searchParams.get('state');
    const req = get(`http://127.0.0.1:8787/callback?code=ok&state=${state}`);
    req.on('error', () => {});
    await started.promise;
    req.destroy();
    exchange.resolve(
      Response.json({ access_token: 'connected', token_type: 'Bearer', expires_in: 3600 }),
    );
    await done;
    await store.locked(async () => {});
    assert.equal((await store.read()).accessToken, 'connected');
  },
);

test('bounded upstream bodies cancel oversized streams and redact send failures', async () => {
  const { readJson } = await import('../dist/body.js');
  let cancelled = false;
  const body = new ReadableStream({
    pull(c) {
      c.enqueue(new Uint8Array(128));
    },
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(readJson(new Response(body), 64));
  assert.equal(cancelled, true);
  let calls = 0;
  const client = new XClient(
    async () => 'token',
    true,
    async () => {
      calls++;
      return Response.json({});
    },
  );
  await assert.rejects(client.send('123', 'hello'), /delivery is unknown/);
  assert.equal(calls, 1);
});
