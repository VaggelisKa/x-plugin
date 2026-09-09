import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Vault, RedisStore } from '../dist/hosted/store.js';
import {
  HostedOAuth,
  CHATGPT_CLIENT,
  CHATGPT_REDIRECT,
  CLAUDE_CODE_CLIENT,
  CLAUDE_REDIRECT,
  hash,
  redirectMatches,
  registrable,
} from '../dist/hosted/oauth.js';
import { createHostedHandler, hostedHandler } from '../dist/hosted/handler.js';
import { hostedConfig } from '../dist/hosted/config.js';

class MemoryStore {
  records = new Map();
  counts = new Map();
  async get(key) {
    const entry = this.records.get(key);
    return entry && entry.expires > Date.now() ? entry.value : null;
  }
  async cas(key, expected, next, ttl) {
    // Deliberately synchronous critical section: same atomic contract as Redis CAS.
    const entry = this.records.get(key);
    const current = entry && entry.expires > Date.now() ? entry.value : null;
    if (current !== expected) return false;
    if (next === null) this.records.delete(key);
    else this.records.set(key, { value: next, expires: Date.now() + ttl * 1000 });
    return true;
  }
  async limit(key, maximum) {
    const n = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, n);
    return n <= maximum;
  }
}
function setup(overrides = {}) {
  const config = {
    origin: 'https://plugin.example',
    xClientId: 'x-client',
    xClientSecret: 'x-secret',
    allowedUserIds: ['101', '202'],
    encryptionKey: randomBytes(32).toString('hex'),
    ...overrides,
  };
  const store = new MemoryStore();
  const vault = new Vault(store, config.encryptionKey, hash(config.origin));
  const calls = [];
  let refreshFail = false;
  let refreshStatus = 0;
  const request = async (input, options = {}) => {
    const url = String(input);
    calls.push({ url, options });
    if (url === CLAUDE_CODE_CLIENT)
      return Response.json({
        client_id: CLAUDE_CODE_CLIENT,
        client_name: 'Claude Code',
        redirect_uris: ['http://localhost/callback', 'http://127.0.0.1/callback'],
        token_endpoint_auth_method: 'none',
      });
    if (url === CHATGPT_CLIENT)
      return Response.json({
        client_id: CHATGPT_CLIENT,
        redirect_uris: [CHATGPT_REDIRECT],
        token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'],
      });
    if (url.endsWith('/oauth2/token')) {
      assert.equal(
        options.headers.Authorization,
        `Basic ${Buffer.from('x-client:x-secret').toString('base64')}`,
      );
      const params = new URLSearchParams(options.body);
      if (params.get('grant_type') === 'refresh_token' && refreshFail)
        throw new Error('private upstream details');
      if (params.get('grant_type') === 'refresh_token' && refreshStatus)
        return new Response('{"error":"private upstream details"}', { status: refreshStatus });
      const user = params.get('code') ?? params.get('refresh_token').split('-')[1];
      return Response.json({
        access_token: `access-${user}`,
        refresh_token: `refresh-${user}`,
        token_type: 'bearer',
        expires_in: 7200,
        scope: 'tweet.read users.read dm.read offline.access',
      });
    }
    if (url.endsWith('/users/me'))
      return Response.json({ data: { id: options.headers.Authorization.split('-')[1] } });
    throw new Error(`Unexpected external URL: ${url}`);
  };
  const oauth = new HostedOAuth(config, vault, request);
  const handler = createHostedHandler(config, store, request);
  const verifier = 'v'.repeat(43);
  function params(changes = {}) {
    return new URLSearchParams({
      client_id: CHATGPT_CLIENT,
      redirect_uri: CHATGPT_REDIRECT,
      response_type: 'code',
      resource: `${config.origin}/mcp`,
      scope: 'x.read',
      state: 'chatgpt-state',
      code_challenge_method: 'S256',
      code_challenge: hash(verifier),
      ...changes,
    });
  }
  async function flow(user = '101') {
    const start = await oauth.begin(params());
    const target = new URL(await oauth.consent(start.flowId, start.browser));
    const result = new URL(
      await oauth.callback(
        new URLSearchParams({ code: user, state: target.searchParams.get('state') }),
        start.browser,
      ),
    );
    return { code: result.searchParams.get('code'), result };
  }
  function exchangeParams(code, changes = {}) {
    return new URLSearchParams({
      client_id: CHATGPT_CLIENT,
      resource: `${config.origin}/mcp`,
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: CHATGPT_REDIRECT,
      ...changes,
    });
  }
  async function connect(user = '101') {
    const { code } = await flow(user);
    return oauth.exchange(exchangeParams(code));
  }
  return {
    config,
    store,
    vault,
    calls,
    oauth,
    handler,
    verifier,
    params,
    flow,
    connect,
    exchangeParams,
    failRefresh: () => {
      refreshFail = true;
    },
    failRefreshWith: (status) => {
      refreshStatus = status;
    },
  };
}

test('hosted consent, callback and token exchange work through HTTP with browser binding', async () => {
  const s = setup();
  const start = await s.handler(new Request(`${s.config.origin}/oauth/authorize?${s.params()}`));
  assert.equal(start.status, 200);
  assert.equal(start.headers.get('Referrer-Policy'), 'same-origin');
  assert.equal(
    start.headers.get('Content-Security-Policy'),
    "default-src 'none'; form-action 'self' https://x.com; frame-ancestors 'none'; base-uri 'none'",
  );
  const cookie = start.headers.get('set-cookie').split(';')[0];
  assert.match(start.headers.get('set-cookie'), /HttpOnly; Secure; SameSite=Lax/);
  const flow = (await start.text()).match(/name="flow" value="([^"]+)"/)[1];
  for (const origin of ['null', 'https://evil.example']) {
    const rejected = await s.handler(
      new Request(`${s.config.origin}/oauth/consent`, {
        method: 'POST',
        headers: { cookie, origin, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ flow }),
      }),
    );
    assert.equal(rejected.status, 403);
  }
  const consent = await s.handler(
    new Request(`${s.config.origin}/oauth/consent`, {
      method: 'POST',
      headers: {
        cookie,
        origin: s.config.origin,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ flow }),
    }),
  );
  assert.equal(consent.status, 303);
  const state = new URL(consent.headers.get('location')).searchParams.get('state');
  const callback = await s.handler(
    new Request(`${s.config.origin}/oauth/x/callback?state=${state}&code=101`, {
      headers: { cookie },
    }),
  );
  assert.equal(callback.status, 303);
  assert.equal(callback.headers.get('Referrer-Policy'), 'no-referrer');
  const target = new URL(callback.headers.get('location'));
  assert.equal(target.searchParams.get('iss'), s.config.origin);
  assert.equal(target.searchParams.get('state'), 'chatgpt-state');
  const token = await s.handler(
    new Request(`${s.config.origin}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: s.exchangeParams(target.searchParams.get('code')),
    }),
  );
  assert.equal(token.status, 200);
  assert.equal(token.headers.get('Cache-Control'), 'no-store');
  assert.ok((await token.json()).access_token);
  assert.ok(!JSON.stringify([...s.store.records.values()]).includes('access-101'));
});

test('rejects untrusted clients and redirects before outbound requests; later errors return to the client', async () => {
  for (const changes of [
    { client_id: 'http://127.0.0.1/client' },
    { redirect_uri: 'https://evil.example' },
    { redirect_uri: 'javascript:alert(1)' },
  ]) {
    const s = setup();
    await assert.rejects(s.oauth.begin(s.params(changes)));
    assert.equal(s.calls.length, 0);
  }
  for (const [changes, error] of [
    [{ resource: 'https://other/mcp' }, 'invalid_target'],
    [{ scope: 'dm.write' }, 'invalid_scope'],
    [{ code_challenge_method: 'plain' }, 'invalid_request'],
    [{ response_type: 'token' }, 'unsupported_response_type'],
  ]) {
    const s = setup();
    const result = await s.oauth.begin(s.params(changes));
    const target = new URL(result.redirect);
    assert.equal(target.origin + target.pathname, CHATGPT_REDIRECT);
    assert.equal(target.searchParams.get('error'), error);
    assert.equal(target.searchParams.get('state'), 'chatgpt-state');
    assert.equal(target.searchParams.get('iss'), s.config.origin);
    assert.ok(![...s.store.records.keys()].some((k) => k.includes(':consent:')));
    const http = await s.handler(
      new Request(`${s.config.origin}/oauth/authorize?${s.params(changes)}`),
    );
    assert.equal(http.status, 303);
  }
  const s = setup(),
    params = s.params();
  params.append('state', 'duplicate');
  const duplicate = new URL((await s.oauth.begin(params)).redirect);
  assert.equal(duplicate.searchParams.get('error'), 'invalid_request');
  assert.equal(duplicate.searchParams.has('state'), false);
});

test('wrong browser cannot consume consent or X state; callbacks are single-use', async () => {
  const s = setup(),
    start = await s.oauth.begin(s.params());
  await assert.rejects(s.oauth.consent(start.flowId, 'other-browser'));
  const target = new URL(await s.oauth.consent(start.flowId, start.browser));
  const params = new URLSearchParams({ state: target.searchParams.get('state'), code: '101' });
  await assert.rejects(s.oauth.callback(params, 'other-browser'));
  await s.oauth.callback(params, start.browser);
  await assert.rejects(s.oauth.callback(params, start.browser));
});

test('PKCE, exact redirect and resource are checked; only one concurrent code redemption succeeds', async () => {
  const s = setup(),
    { code } = await s.flow();
  for (const changes of [
    { code_verifier: 'wrong'.repeat(12) },
    { redirect_uri: 'https://other/' },
    { resource: 'https://other/mcp' },
  ])
    await assert.rejects(s.oauth.exchange(s.exchangeParams(code, changes)));
  const results = await Promise.allSettled([
    s.oauth.exchange(s.exchangeParams(code)),
    s.oauth.exchange(s.exchangeParams(code)),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
});

test('account allowlist denies access without storing a grant', async () => {
  const s = setup(),
    { result } = await s.flow('999');
  assert.equal(result.searchParams.get('error'), 'access_denied');
  assert.ok(![...s.store.records.keys()].some((k) => k.includes(':grant:')));
});

test('different connections resolve isolated X tokens and hosted tools never expose sending', async () => {
  const s = setup(),
    a = await s.connect('101'),
    b = await s.connect('202');
  const clients = await Promise.all([
    s.oauth.authenticate(a.access_token),
    s.oauth.authenticate(b.access_token),
  ]);
  assert.deepEqual(await Promise.all(clients.map((c) => c.client.me())), [
    { data: { id: '101' } },
    { data: { id: '202' } },
  ]);
  const meta = {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1' },
    'io.modelcontextprotocol/clientCapabilities': {},
  };
  for (const [method, name] of [
    ['tools/list', undefined],
    ['tools/call', 'x_get_me'],
  ]) {
    const response = await s.handler(
      new Request(`${s.config.origin}/mcp`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${a.access_token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'MCP-Protocol-Version': '2026-07-28',
          'Mcp-Method': method,
          ...(name ? { 'Mcp-Name': name } : {}),
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method,
          params: { _meta: meta, ...(name ? { name, arguments: {} } : {}) },
        }),
      }),
    );
    const text = await response.text();
    assert.equal(response.status, 200, text);
    if (!name) {
      assert.match(text, /x_list_dm_events/);
      assert.doesNotMatch(text, /x_send_dm/);
    } else assert.match(text, /101/);
  }
});

test('refresh rotates downstream tokens; replay revokes the grant and all access tokens', async () => {
  const s = setup(),
    tokens = await s.connect();
  const params = new URLSearchParams({
    client_id: CHATGPT_CLIENT,
    resource: `${s.config.origin}/mcp`,
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token,
  });
  const next = await s.oauth.exchange(params);
  assert.notEqual(next.refresh_token, tokens.refresh_token);
  await s.oauth.authenticate(next.access_token);
  await assert.rejects(s.oauth.exchange(params));
  await assert.rejects(s.oauth.authenticate(next.access_token));
  await assert.rejects(s.oauth.authenticate(tokens.access_token));
});

test('revocation removes X credentials and blocks future calls', async () => {
  const s = setup(),
    tokens = await s.connect();
  await s.oauth.revoke(
    new URLSearchParams({ client_id: CHATGPT_CLIENT, token: tokens.refresh_token }),
  );
  await assert.rejects(s.oauth.authenticate(tokens.access_token));
  assert.ok(![...s.store.records.keys()].some((k) => k.includes(':grant:')));
});

test('concurrent X refresh uses the external refresh token once, and uncertain failures require reconnect', async () => {
  for (const fail of [false, true]) {
    const s = setup(),
      tokens = await s.connect();
    const { grantId, client } = await s.oauth.authenticate(tokens.access_token);
    const key = `grant:${grantId}`,
      record = await s.vault.read(key);
    await s.vault.replace(
      key,
      record.raw,
      { ...record.value, credentials: { ...record.value.credentials, expiresAt: 0 } },
      3600,
    );
    if (fail) s.failRefresh();
    const results = await Promise.allSettled([client.me(), client.me()]);
    assert.equal(
      s.calls.filter(
        (c) =>
          c.url.endsWith('/oauth2/token') &&
          new URLSearchParams(c.options.body).get('grant_type') === 'refresh_token',
      ).length,
      1,
    );
    if (fail) {
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 0);
      await assert.rejects(s.oauth.authenticate(tokens.access_token));
    } else {
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
      assert.deepEqual(await client.me(), { data: { id: '101' } });
    }
  }
});

test('vault detects tampering, cross-record substitution and different encryption keys', () => {
  const s = setup(),
    raw = s.vault.seal('grant:a', { token: 'secret' });
  assert.throws(() => s.vault.open('grant:b', raw));
  assert.throws(() =>
    new Vault(s.store, '00'.repeat(32), hash(s.config.origin)).open('grant:a', raw),
  );
  const modified = Buffer.from(raw, 'base64url');
  modified[30] ^= 1;
  assert.throws(() => s.vault.open('grant:a', modified.toString('base64url')));
});

test('HTTP rejects hostile origins, oversized payloads, and invalid tokens with discovery challenge', async () => {
  const s = setup(),
    tokens = await s.connect();
  const missing = await s.handler(new Request(`${s.config.origin}/mcp`));
  assert.equal(missing.status, 401);
  assert.match(missing.headers.get('WWW-Authenticate'), /oauth-protected-resource\/mcp/);
  const hostile = await s.handler(
    new Request(`${s.config.origin}/mcp`, { headers: { origin: 'https://evil.example' } }),
  );
  assert.equal(hostile.status, 403);
  const large = await s.handler(
    new Request(`${s.config.origin}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        'Content-Type': 'application/json',
      },
      body: 'x'.repeat(131073),
    }),
  );
  assert.equal(large.status, 413);
  assert.equal(
    (await s.handler(new Request('https://spoof.example/.well-known/oauth-authorization-server')))
      .status,
    400,
  );
});

test('configuration fails closed and storage failures never disclose credentials', async () => {
  assert.throws(() => hostedConfig({}));
  assert.equal((await hostedHandler(new Request('https://plugin.example/mcp'))).status, 503);
  const store = new RedisStore('https://redis.example', 'private-secret', async () =>
    Response.json({ error: 'private-secret' }),
  );
  await assert.rejects(store.get('key'), (error) => !error.message.includes('private-secret'));
});

test('Claude Code connects through its client metadata document with an ephemeral loopback port', async () => {
  const s = setup();
  const changes = {
    client_id: CLAUDE_CODE_CLIENT,
    redirect_uri: 'http://localhost:3118/callback',
    scope: 'x.read offline_access',
    state: 'claude-code-state',
  };
  const start = await s.handler(
    new Request(`${s.config.origin}/oauth/authorize?${s.params(changes)}`),
  );
  assert.equal(start.status, 200);
  const page = await start.text();
  assert.match(page, /Connect X to Claude Code/);
  assert.match(page, /localhost:3118/);
  assert.match(page, /Warning/);
  const begin = await s.oauth.begin(s.params(changes));
  const consent = new URL(await s.oauth.consent(begin.flowId, begin.browser));
  const result = new URL(
    await s.oauth.callback(
      new URLSearchParams({ code: '101', state: consent.searchParams.get('state') }),
      begin.browser,
    ),
  );
  assert.equal(result.origin, 'http://localhost:3118');
  assert.equal(result.searchParams.get('state'), 'claude-code-state');
  const tokens = await s.oauth.exchange(
    s.exchangeParams(result.searchParams.get('code'), {
      client_id: CLAUDE_CODE_CLIENT,
      redirect_uri: 'http://localhost:3118/callback',
    }),
  );
  assert.ok(tokens.access_token);
  const { client } = await s.oauth.authenticate(tokens.access_token);
  assert.equal((await client.me()).data.id, '101');
  // Ports differ per session, but host and path must still match exactly.
  for (const redirect_uri of [
    'http://localhost:3118/other',
    'http://evil.example/callback',
    'http://localhost:3118/callback?x=1',
  ])
    await assert.rejects(s.oauth.begin(s.params({ ...changes, redirect_uri })));
});

test('hosted Claude registers dynamically as a public client with the fixed callback only', async () => {
  const s = setup();
  const register = (metadata) =>
    s.handler(
      new Request(`${s.config.origin}/oauth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(metadata),
      }),
    );
  const first = await register({
    client_name: 'Claude',
    redirect_uris: [CLAUDE_REDIRECT],
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
  });
  assert.equal(first.status, 201);
  const registration = await first.json();
  assert.match(registration.client_id, /^dcr-/);
  assert.equal(registration.token_endpoint_auth_method, 'none');
  assert.ok(!('client_secret' in registration));
  const again = await (
    await register({ client_name: 'Claude', redirect_uris: [CLAUDE_REDIRECT] })
  ).json();
  assert.equal(again.client_id, registration.client_id);
  assert.equal([...s.store.records.keys()].filter((k) => k.includes(':client:')).length, 1);
  for (const metadata of [
    { redirect_uris: ['https://evil.example/callback'] },
    { redirect_uris: [CLAUDE_REDIRECT], token_endpoint_auth_method: 'client_secret_post' },
    { redirect_uris: [] },
    { redirect_uris: [CLAUDE_REDIRECT], grant_types: ['client_credentials'] },
    [],
  ])
    assert.equal((await register(metadata)).status, 400);
  const changes = {
    client_id: registration.client_id,
    redirect_uri: CLAUDE_REDIRECT,
    state: 'claude-state',
  };
  const begin = await s.oauth.begin(s.params(changes));
  assert.equal(begin.clientName, 'Claude (unverified client)');
  assert.equal(begin.loopback, false);
  const consent = new URL(await s.oauth.consent(begin.flowId, begin.browser));
  const result = new URL(
    await s.oauth.callback(
      new URLSearchParams({ code: '202', state: consent.searchParams.get('state') }),
      begin.browser,
    ),
  );
  assert.equal(result.origin + result.pathname, CLAUDE_REDIRECT);
  const tokens = await s.oauth.exchange(
    s.exchangeParams(result.searchParams.get('code'), {
      client_id: registration.client_id,
      redirect_uri: CLAUDE_REDIRECT,
    }),
  );
  // Codes are bound to the registering client; ChatGPT cannot redeem Claude's code and vice versa.
  const { code } = await s.flow('101');
  await assert.rejects(
    s.oauth.exchange(s.exchangeParams(code, { client_id: registration.client_id })),
  );
  const refreshed = await s.oauth.exchange(
    new URLSearchParams({
      client_id: registration.client_id,
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
    }),
  );
  assert.ok(refreshed.access_token);
  await assert.rejects(
    s.oauth.begin(s.params({ ...changes, redirect_uri: 'http://localhost:1234/callback' })),
  );
  await assert.rejects(s.oauth.begin(s.params({ ...changes, client_id: 'dcr-unknown' })));
});

test('OAuth routes are limited per client address before the deployment ceiling', async () => {
  const s = setup();
  const metadata = new Request(`${s.config.origin}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'x-real-ip': '203.0.113.9' },
    body: new URLSearchParams({ grant_type: 'password' }),
  });
  let last;
  for (let i = 0; i < 61; i++) last = await s.handler(metadata.clone());
  assert.equal(last.status, 429);
  assert.equal(last.headers.get('Retry-After'), '60');
  const other = await s.handler(
    new Request(`${s.config.origin}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'x-real-ip': '203.0.113.10' },
      body: new URLSearchParams({ grant_type: 'password' }),
    }),
  );
  assert.equal(other.status, 400);
});

test('loopback redirects match on host and path only; registration accepts nothing else', () => {
  const loopback = 'http://localhost/callback';
  for (const requested of [
    'http://localhost/callback',
    'http://localhost:3118/callback',
    'http://localhost:65535/callback',
  ])
    assert.ok(redirectMatches(loopback, requested), requested);
  for (const requested of [
    'http://localhost.evil.com/callback',
    'http://localhost.evil.com:80/callback',
    'http://user@localhost/callback',
    'http://localhost:3118/callback/',
    'http://localhost:3118/other',
    'http://localhost:3118/callback?x=1',
    'http://localhost:3118/callback#x',
    'https://localhost/callback',
    'http://127.0.0.1:3118/callback',
    'http://[::1]:3118/callback',
    'http://evil.example/callback',
    'javascript:alert(1)',
    '',
  ])
    assert.equal(redirectMatches(loopback, requested), false, requested);
  assert.ok(redirectMatches('http://127.0.0.1/callback', 'http://127.0.0.1:4242/callback'));
  assert.ok(redirectMatches('http://[::1]/callback', 'http://[::1]:4242/callback'));
  assert.ok(redirectMatches(CLAUDE_REDIRECT, CLAUDE_REDIRECT));
  assert.equal(redirectMatches(CLAUDE_REDIRECT, `${CLAUDE_REDIRECT}/`), false);
  for (const redirect of [CLAUDE_REDIRECT, CHATGPT_REDIRECT, 'http://[::1]:5/callback'])
    assert.ok(registrable(redirect), redirect);
  for (const redirect of ['https://claude.ai/other', 'https://evil.example/', 'not a url'])
    assert.equal(registrable(redirect), false, redirect);
});

test('registered client names are labeled unverified on the consent page', async () => {
  const s = setup();
  const { client_id } = await s.oauth.register({
    client_name: 'ChatGPT',
    redirect_uris: ['http://localhost/callback'],
  });
  const page = await (
    await s.handler(
      new Request(
        `${s.config.origin}/oauth/authorize?${s.params({ client_id, redirect_uri: 'http://localhost:9/callback' })}`,
      ),
    )
  ).text();
  assert.match(page, /Connect X to ChatGPT \(unverified client\)/);
  assert.match(page, /Warning/);
});

test('X outages during refresh keep the grant; only rejected refreshes require reconnecting', async () => {
  const s = setup(),
    tokens = await s.connect();
  const { grantId, client } = await s.oauth.authenticate(tokens.access_token);
  const key = `grant:${grantId}`,
    record = await s.vault.read(key);
  await s.vault.replace(
    key,
    record.raw,
    { ...record.value, credentials: { ...record.value.credentials, expiresAt: 0 } },
    3600,
  );
  s.failRefreshWith(503);
  await assert.rejects(client.me(), (error) => error.status === 503);
  const kept = await s.vault.read(key);
  assert.ok(kept && !kept.value.refreshing);
  s.failRefreshWith(400);
  await assert.rejects(client.me(), (error) => /Reconnect/.test(error.message));
  assert.equal(await s.vault.read(key), null);
});
