import { createMcpHandler } from '@modelcontextprotocol/server';
import { createServer } from '../server.js';
import { hostedConfig, type HostedConfig } from './config.js';
import { HostedOAuth, OAuthError, one, hash } from './oauth.js';
import { RedisStore, Vault, type Store } from './store.js';

const COOKIE = '__Host-x-plugin-login';
const security = {
  'Cache-Control': 'no-store',
  Pragma: 'no-cache',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy':
    "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
};
function cookie(request: Request) {
  const values = (request.headers.get('cookie') ?? '')
    .split(';')
    .map((v) => v.trim())
    .filter((v) => v.startsWith(`${COOKIE}=`));
  return values.length === 1 ? values[0]!.slice(COOKIE.length + 1) : '';
}
function setCookie(value: string) {
  return `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${value ? 600 : 0}`;
}
function escape(value: string) {
  return value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}
async function body(request: Request, max: number): Promise<string> {
  if (
    request.headers.get('content-encoding') &&
    request.headers.get('content-encoding') !== 'identity'
  )
    throw new OAuthError('unsupported_media_type', 415);
  if (Number(request.headers.get('content-length')) > max)
    throw new OAuthError('request_too_large', 413);
  if (!request.body) throw new OAuthError('invalid_request');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > max) throw new OAuthError('request_too_large', 413);
          chunks.push(value);
        }
        return Buffer.concat(chunks).toString('utf8');
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new OAuthError('request_timeout', 408)), 10_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
  }
}
async function form(request: Request) {
  if (
    request.headers.get('content-type')?.split(';')[0]?.trim() !==
    'application/x-www-form-urlencoded'
  )
    throw new OAuthError('unsupported_media_type', 415);
  return new URLSearchParams(await body(request, 16 * 1024));
}
function html(contents: string, headers?: HeadersInit) {
  return new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>X Plugin</title><body><main>${contents}</main></body></html>`,
    {
      headers: { 'Content-Type': 'text/html; charset=utf-8', ...headers },
    },
  );
}

export function createHostedHandler(config: HostedConfig, store: Store, request = fetch) {
  const vault = new Vault(store, config.encryptionKey, hash(config.origin));
  const oauth = new HostedOAuth(config, vault, request);
  const challenge = `Bearer resource_metadata="${config.origin}/.well-known/oauth-protected-resource/mcp", scope="x.read"`;
  async function route(req: Request) {
    const url = new URL(req.url);
    // Canonical origin is configured, never inferred from forwarded headers.
    if (url.origin !== config.origin) throw new OAuthError('invalid_request');
    if (
      req.headers.get('origin') &&
      req.headers.get('origin') !== config.origin &&
      req.headers.get('origin') !== 'https://chatgpt.com'
    )
      throw new OAuthError('invalid_origin', 403);
    const path = url.pathname;
    if (
      req.method === 'GET' &&
      (path === '/.well-known/oauth-authorization-server' ||
        path === '/.well-known/oauth-authorization-server/mcp')
    )
      return Response.json(oauth.metadata());
    if (
      req.method === 'GET' &&
      (path === '/.well-known/oauth-protected-resource' ||
        path === '/.well-known/oauth-protected-resource/mcp')
    )
      return Response.json({
        resource: oauth.resource,
        authorization_servers: [config.origin],
        scopes_supported: ['x.read'],
        bearer_methods_supported: ['header'],
      });
    if (req.method === 'GET' && path === '/')
      return html(
        '<h1>X Plugin</h1><p>Connect your X account from ChatGPT to search posts and read recent direct messages.</p><p>This version cannot send messages. Your X credentials are encrypted; message bodies are not stored by this service.</p><p>Connect using the MCP endpoint: <code>/mcp</code>.</p><p>To disconnect, remove the connection in ChatGPT and revoke X Plugin in your X account settings. Connections expire after 30 days.</p>',
      );
    if (req.method === 'GET' && path === '/health') {
      await store.get(vault.keyFor('health'));
      return Response.json({ status: 'ready', mode: 'read-only' });
    }
    if (path === '/mcp') {
      const bearer = req.headers.get('authorization')?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
      if (!bearer) throw new OAuthError('invalid_token', 401);
      const { client, grantId } = await oauth.authenticate(bearer);
      if (!(await store.limit(vault.keyFor(`rate:mcp:${grantId}`), 60, 60)))
        throw new OAuthError('rate_limited', 429);
      if (req.method !== 'POST')
        return new Response(null, { status: 405, headers: { Allow: 'POST' } });
      if (
        req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json'
      )
        throw new OAuthError('unsupported_media_type', 415);
      const text = await body(req, 128 * 1024);
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new OAuthError('invalid_request');
      }
      if (Array.isArray(parsed)) throw new OAuthError('invalid_request');
      // One client per request: never share user tokens in a module-global MCP server.
      const mcp = createMcpHandler(() => createServer(client));
      const headers = new Headers(req.headers);
      headers.delete('content-length');
      return mcp.fetch(
        new Request(req.url, { method: 'POST', headers, body: text, signal: req.signal }),
      );
    }
    if (
      ![
        '/oauth/authorize',
        '/oauth/consent',
        '/oauth/x/callback',
        '/oauth/token',
        '/oauth/revoke',
      ].includes(path)
    )
      return new Response(null, { status: 404 });
    // A conservative deployment-wide ceiling also bounds anonymous authorization traffic.
    if (!(await store.limit(vault.keyFor(`rate:oauth:${path}`), 60, 60)))
      throw new OAuthError('rate_limited', 429);
    if (path === '/oauth/authorize' && req.method === 'GET') {
      const { flowId, browser } = await oauth.begin(url.searchParams);
      return html(
        `<h1>Connect X to ChatGPT</h1><p>Allow ChatGPT to read your X profile, posts, and recent direct messages through X Plugin. Sending is disabled.</p><p>X credentials are stored encrypted for up to 30 days. Requested content is shared with ChatGPT. You can revoke access in X settings.</p><form method="post" action="/oauth/consent"><input type="hidden" name="flow" value="${escape(flowId)}"><button type="submit">Continue to X</button></form>`,
        { 'Set-Cookie': setCookie(browser) },
      );
    }
    if (path === '/oauth/consent' && req.method === 'POST') {
      if (req.headers.get('origin') !== config.origin) throw new OAuthError('invalid_origin', 403);
      const target = await oauth.consent(one(await form(req), 'flow'), cookie(req));
      return new Response(null, { status: 303, headers: { Location: target } });
    }
    if (path === '/oauth/x/callback' && req.method === 'GET') {
      const target = await oauth.callback(url.searchParams, cookie(req));
      return new Response(null, {
        status: 303,
        headers: { Location: target, 'Set-Cookie': setCookie('') },
      });
    }
    if (path === '/oauth/token' && req.method === 'POST')
      return Response.json(await oauth.exchange(await form(req)));
    if (path === '/oauth/revoke' && req.method === 'POST') {
      await oauth.revoke(await form(req));
      return new Response(null, { status: 200 });
    }
    return new Response(null, {
      status: 405,
      headers: {
        Allow: path === '/oauth/authorize' || path === '/oauth/x/callback' ? 'GET' : 'POST',
      },
    });
  }
  return async (req: Request): Promise<Response> => {
    let response: Response;
    try {
      response = await route(req);
    } catch (error) {
      const status = error instanceof OAuthError ? error.status : 503;
      response = Response.json(
        { error: error instanceof OAuthError ? error.code : 'temporarily_unavailable' },
        { status },
      );
      if (status === 401) response.headers.set('WWW-Authenticate', challenge);
      if (status === 429) response.headers.set('Retry-After', '60');
    }
    for (const [key, value] of Object.entries(security)) response.headers.set(key, value);
    return response;
  };
}

let handler: ReturnType<typeof createHostedHandler> | undefined;
export async function hostedHandler(req: Request) {
  try {
    if (!handler) {
      const config = hostedConfig();
      handler = createHostedHandler(config, new RedisStore(config.redisUrl, config.redisToken));
    }
    return await handler(req);
  } catch {
    return Response.json({ error: 'service_not_configured' }, { status: 503, headers: security });
  }
}
