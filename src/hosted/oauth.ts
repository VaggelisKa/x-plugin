import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { authorization, tokenRequest, type Credentials } from '../auth.js';
import { readJson } from '../body.js';
import { XClient, XError } from '../x-client.js';
import type { HostedConfig } from './config.js';
import { Vault } from './store.js';

export const CHATGPT_CLIENT = 'https://chatgpt.com/oauth/client.json';
export const CHATGPT_REDIRECT = 'https://chatgpt.com/connector_platform_oauth_redirect';
const GRANT_SECONDS = 30 * 24 * 3600;
const ACCESS_SECONDS = 3600;
export const random = () => randomBytes(32).toString('base64url');
export const hash = (value: string) => createHash('sha256').update(value).digest('base64url');
function equal(a: string, b: string) {
  const aa = Buffer.from(a),
    bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}
export class OAuthError extends Error {
  constructor(
    readonly code: string,
    readonly status = 400,
  ) {
    super(code);
  }
}
function assert(value: unknown, code = 'invalid_request', status = 400): asserts value {
  if (!value) throw new OAuthError(code, status);
}
export function one(params: URLSearchParams, key: string) {
  const values = params.getAll(key);
  assert(values.length <= 1);
  const value = values[0] ?? '';
  assert(value.length <= 4096);
  return value;
}
type Flow = {
  clientId: string;
  redirect: string;
  resource: string;
  challenge: string;
  state: string;
  browserHash: string;
  verifier?: string;
  expires: number;
};
type Code = Flow & { grant: string };
type Grant = { credentials: Credentials; userId: string; expires: number; refreshing?: boolean };
type Token = { grant: string; clientId: string; resource: string; expires: number; used?: boolean };

/** Restricted ChatGPT CIMD client: no arbitrary URL fetching, DCR, or redirect wildcards. */
export class HostedOAuth {
  readonly resource: string;
  constructor(
    readonly config: HostedConfig,
    readonly vault: Vault,
    private request = fetch,
  ) {
    this.resource = `${config.origin}/mcp`;
  }
  metadata() {
    return {
      issuer: this.config.origin,
      authorization_endpoint: `${this.config.origin}/oauth/authorize`,
      token_endpoint: `${this.config.origin}/oauth/token`,
      revocation_endpoint: `${this.config.origin}/oauth/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none'],
      revocation_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256'],
      scopes_supported: ['x.read'],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    };
  }
  private ttl(expires: number) {
    return Math.max(1, Math.ceil((expires - Date.now()) / 1000));
  }
  private async load<T extends { expires: number }>(key: string) {
    const record = await this.vault.read<T>(key);
    assert(record && record.value.expires > Date.now(), 'invalid_grant');
    return record;
  }
  private async client(clientId: string, redirect: string) {
    assert(clientId === CHATGPT_CLIENT && redirect === CHATGPT_REDIRECT, 'invalid_client');
    const response = await this.request(CHATGPT_CLIENT, {
      redirect: 'error',
      signal: AbortSignal.timeout(8_000),
    });
    assert(response.ok, 'temporarily_unavailable', 503);
    const doc = (await readJson(response, 65536)) as Record<string, unknown>;
    const methods = doc.token_endpoint_auth_methods_supported ?? [doc.token_endpoint_auth_method];
    assert(
      doc.client_id === CHATGPT_CLIENT &&
        Array.isArray(doc.redirect_uris) &&
        doc.redirect_uris.includes(redirect) &&
        Array.isArray(methods) &&
        methods.includes('none'),
      'invalid_client',
    );
  }
  async begin(params: URLSearchParams) {
    const clientId = one(params, 'client_id'),
      redirect = one(params, 'redirect_uri');
    assert(one(params, 'response_type') === 'code');
    assert(one(params, 'code_challenge_method') === 'S256');
    const challenge = one(params, 'code_challenge');
    assert(/^[A-Za-z0-9_-]{43}$/.test(challenge));
    assert(one(params, 'resource') === this.resource, 'invalid_target');
    const scope = one(params, 'scope');
    assert(scope === 'x.read', 'invalid_scope');
    const state = one(params, 'state');
    assert(state.length > 0);
    await this.client(clientId, redirect);
    const flowId = random(),
      browser = random();
    const flow: Flow = {
      clientId,
      redirect,
      resource: this.resource,
      challenge,
      state,
      browserHash: hash(browser),
      expires: Date.now() + 600_000,
    };
    await this.vault.create(`consent:${hash(flowId)}`, flow, 600);
    return { flowId, browser };
  }
  private async browserFlow(key: string, browser: string) {
    const record = await this.load<Flow>(key);
    assert(browser && equal(record.value.browserHash, hash(browser)), 'invalid_request');
    return record;
  }
  async consent(flowId: string, browser: string) {
    const key = `consent:${hash(flowId)}`;
    const record = await this.browserFlow(key, browser);
    assert(await this.vault.replace(key, record.raw, null, 1));
    const x = authorization(this.config.xClientId, `${this.config.origin}/oauth/x/callback`);
    await this.vault.create(
      `flow:${hash(x.state)}`,
      { ...record.value, verifier: x.verifier },
      this.ttl(record.value.expires),
    );
    return x.url;
  }
  async callback(params: URLSearchParams, browser: string) {
    const state = one(params, 'state');
    assert(state);
    const key = `flow:${hash(state)}`;
    const record = await this.browserFlow(key, browser);
    assert(await this.vault.replace(key, record.raw, null, 1));
    const target = new URL(record.value.redirect);
    target.searchParams.set('state', record.value.state);
    target.searchParams.set('iss', this.config.origin);
    if (one(params, 'error')) {
      target.searchParams.set('error', 'access_denied');
      return target.toString();
    }
    const code = one(params, 'code');
    assert(code && record.value.verifier);
    const credentials = await tokenRequest(
      this.config.xClientId,
      {
        grant_type: 'authorization_code',
        code,
        code_verifier: record.value.verifier,
        redirect_uri: `${this.config.origin}/oauth/x/callback`,
      },
      this.request,
      this.config.xClientSecret,
    );
    assert(
      ['tweet.read', 'users.read', 'dm.read', 'offline.access'].every((s) =>
        credentials.scope.split(' ').includes(s),
      ),
      'access_denied',
    );
    const identity = await new XClient(
      async () => credentials.accessToken,
      false,
      this.request,
    ).me();
    const userId = (identity.data as { id?: string } | undefined)?.id;
    assert(userId && /^\d{1,19}$/.test(userId), 'access_denied');
    if (!this.config.allowedUserIds.includes('*') && !this.config.allowedUserIds.includes(userId)) {
      target.searchParams.set('error', 'access_denied');
      return target.toString();
    }
    const grant = random(),
      authCode = random();
    await this.vault.create(
      `grant:${grant}`,
      { credentials, userId, expires: Date.now() + GRANT_SECONDS * 1000 } satisfies Grant,
      GRANT_SECONDS,
    );
    // X's verifier is no longer needed; never place X tokens inside downstream codes.
    const { verifier: _verifier, ...flow } = record.value;
    await this.vault.create(
      `code:${hash(authCode)}`,
      { ...flow, grant, expires: Date.now() + 120_000 } satisfies Code,
      120,
    );
    target.searchParams.set('code', authCode);
    return target.toString();
  }
  async exchange(params: URLSearchParams) {
    const clientId = one(params, 'client_id');
    assert(clientId === CHATGPT_CLIENT, 'invalid_client');
    assert(one(params, 'resource') === this.resource, 'invalid_target');
    const scope = one(params, 'scope');
    assert(!scope || scope === 'x.read', 'invalid_scope');
    const type = one(params, 'grant_type');
    let grantId: string;
    if (type === 'authorization_code') {
      const key = `code:${hash(one(params, 'code'))}`;
      const record = await this.load<Code>(key);
      const verifier = one(params, 'code_verifier');
      assert(
        /^[A-Za-z0-9._~-]{43,128}$/.test(verifier) && equal(hash(verifier), record.value.challenge),
        'invalid_grant',
      );
      assert(
        record.value.clientId === clientId &&
          record.value.resource === this.resource &&
          record.value.redirect === one(params, 'redirect_uri'),
        'invalid_grant',
      );
      assert(await this.vault.replace(key, record.raw, null, 1), 'invalid_grant');
      grantId = record.value.grant;
    } else if (type === 'refresh_token') {
      const key = `refresh:${hash(one(params, 'refresh_token'))}`;
      const record = await this.load<Token>(key);
      assert(
        record.value.clientId === clientId && record.value.resource === this.resource,
        'invalid_grant',
      );
      if (record.value.used) {
        await this.revokeGrant(record.value.grant);
        throw new OAuthError('invalid_grant');
      }
      assert(
        await this.vault.replace(
          key,
          record.raw,
          { ...record.value, used: true },
          this.ttl(record.value.expires),
        ),
        'invalid_grant',
      );
      grantId = record.value.grant;
    } else throw new OAuthError('unsupported_grant_type');
    const grant = await this.load<Grant>(`grant:${grantId}`);
    const accessToken = random(),
      refreshToken = random();
    const accessExpires = Math.min(grant.value.expires, Date.now() + ACCESS_SECONDS * 1000);
    const base = { grant: grantId, clientId, resource: this.resource };
    await this.vault.create(
      `access:${hash(accessToken)}`,
      { ...base, expires: accessExpires } satisfies Token,
      this.ttl(accessExpires),
    );
    await this.vault.create(
      `refresh:${hash(refreshToken)}`,
      { ...base, expires: grant.value.expires } satisfies Token,
      this.ttl(grant.value.expires),
    );
    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: this.ttl(accessExpires),
      refresh_token: refreshToken,
      scope: 'x.read',
    };
  }
  private async revokeGrant(grantId: string) {
    // CAS retry covers the one in-flight refresh writer. Nothing can recreate a deleted grant.
    for (let i = 0; i < 3; i++) {
      const grant = await this.vault.read<Grant>(`grant:${grantId}`);
      if (!grant || (await this.vault.replace(`grant:${grantId}`, grant.raw, null, 1))) return;
    }
    throw new OAuthError('temporarily_unavailable', 503);
  }
  async revoke(params: URLSearchParams) {
    assert(one(params, 'client_id') === CHATGPT_CLIENT, 'invalid_client');
    const token = one(params, 'token');
    assert(token);
    for (const prefix of ['access', 'refresh']) {
      const record = await this.vault.read<Token>(`${prefix}:${hash(token)}`);
      if (record?.value.clientId === CHATGPT_CLIENT) await this.revokeGrant(record.value.grant);
    }
  }
  async authenticate(bearer: string) {
    assert(/^[A-Za-z0-9_-]{43}$/.test(bearer), 'invalid_token', 401);
    let record;
    try {
      record = await this.load<Token>(`access:${hash(bearer)}`);
    } catch (error) {
      if (error instanceof OAuthError) throw new OAuthError('invalid_token', 401);
      throw error;
    }
    assert(
      record.value.resource === this.resource && record.value.clientId === CHATGPT_CLIENT,
      'invalid_token',
      401,
    );
    const grantId = record.value.grant;
    const grant = await this.vault.read<Grant>(`grant:${grantId}`);
    assert(grant && grant.value.expires > Date.now(), 'invalid_token', 401);
    return { grantId, client: new XClient(() => this.xToken(grantId), false, this.request) };
  }
  private async xToken(grantId: string): Promise<string> {
    const key = `grant:${grantId}`;
    const record = await this.load<Grant>(key);
    const { credentials: current, expires, refreshing } = record.value;
    if (refreshing)
      throw new XError(
        'X reconnection may be required: a token refresh is running or was interrupted. Retry once later; reconnect if it persists.',
      );
    if (current.expiresAt > Date.now() + 60_000) return current.accessToken;
    if (!current.refreshToken)
      throw new XError('Reconnect X through the plugin connection settings.');
    // Mark before the external call. Never replay a potentially rotated token after a crash.
    const pending = { ...record.value, refreshing: true };
    const sealed = this.vault.seal(key, pending);
    if (
      !(await this.vault.store.cas(this.vault.keyFor(key), record.raw, sealed, this.ttl(expires)))
    )
      throw new XError('Another request is refreshing X authorization. Retry later.');
    try {
      const next = await tokenRequest(
        this.config.xClientId,
        { grant_type: 'refresh_token', refresh_token: current.refreshToken },
        this.request,
        this.config.xClientSecret,
      );
      next.refreshToken ??= current.refreshToken;
      next.scope ||= current.scope;
      if (
        !['tweet.read', 'users.read', 'dm.read'].every((scope) =>
          next.scope.split(' ').includes(scope),
        )
      )
        throw new Error('Scope reduced.');
      if (
        !(await this.vault.replace(
          key,
          sealed,
          { ...record.value, credentials: next },
          this.ttl(expires),
        ))
      )
        throw new Error('Grant was revoked.');
      return next.accessToken;
    } catch {
      await this.vault.replace(key, sealed, null, 1);
      throw new XError(
        'X authorization could not be refreshed. Reconnect X through the plugin connection settings.',
      );
    }
  }
}
