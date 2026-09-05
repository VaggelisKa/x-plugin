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
