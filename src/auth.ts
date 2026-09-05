import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile, rename, unlink, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { XError, type Fetch } from './x-client.js';

export type Credentials = {
  clientId: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  scope: string;
};
export const configDir = () =>
  process.env.X_PLUGIN_CONFIG_DIR || join(homedir(), '.config', 'x-plugin');

export class CredentialStore {
  constructor(readonly directory = configDir()) {}
  async read(): Promise<Credentials> {
    try {
      const c = JSON.parse(
        await readFile(join(this.directory, 'credentials.json'), 'utf8'),
      ) as Credentials;
      if (
        typeof c.clientId !== 'string' ||
        typeof c.accessToken !== 'string' ||
        !Number.isFinite(c.expiresAt) ||
        typeof c.scope !== 'string'
      )
        throw new Error();
      return c;
    } catch {
      throw new XError('No valid credentials found. Run x-plugin auth login first.');
    }
  }
  async write(value: Credentials) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = join(this.directory, `credentials-${randomBytes(12).toString('hex')}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
      await rename(temporary, join(this.directory, 'credentials.json'));
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }
  async clear() {
    await unlink(join(this.directory, 'credentials.json')).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== 'ENOENT') throw e;
    });
  }
  async locked<T>(action: () => Promise<T>): Promise<T> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const lock = join(this.directory, 'auth.lock');
    try {
      await mkdir(lock, { mode: 0o700 });
    } catch {
      throw new XError(
        'Another authentication operation is running. Retry when it finishes. If it crashed, remove auth.lock from your config directory.',
      );
    }
    try {
      return await action();
    } finally {
      await rmdir(lock);
    }
  }
}

export function authorization(clientId: string, redirectUri: string, write = false) {
  const verifier = randomBytes(32).toString('base64url');
  const state = randomBytes(32).toString('base64url');
  const url = new URL('https://x.com/i/oauth2/authorize');
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: `tweet.read users.read dm.read offline.access${write ? ' dm.write' : ''}`,
    state,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
  }).toString();
  return { url: url.toString(), verifier, state };
}

export async function tokenRequest(
  clientId: string,
  params: Record<string, string>,
  request: Fetch = fetch,
): Promise<Credentials> {
  let response: Response;
  try {
    response = await request('https://api.x.com/2/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, ...params }),
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new XError('X token exchange failed. Run auth login again if a refresh was interrupted.');
  }
  if (!response.ok)
    throw new XError(
      `X token exchange failed (HTTP ${response.status}). Check your Native App client ID and callback URL; reauthorize if needed.`,
    );
  let t: Record<string, unknown>;
  try {
    t = (await response.json()) as Record<string, unknown>;
  } catch {
    throw new XError('Invalid token response from X.');
  }
  if (
    !t ||
    typeof t.access_token !== 'string' ||
    typeof t.expires_in !== 'number' ||
    !Number.isFinite(t.expires_in) ||
    t.expires_in <= 0 ||
    t.token_type !== 'bearer'
  )
    throw new XError('Invalid token response from X.');
  return {
    clientId,
    accessToken: t.access_token,
    refreshToken: typeof t.refresh_token === 'string' ? t.refresh_token : undefined,
    expiresAt: Date.now() + t.expires_in * 1000,
    scope: typeof t.scope === 'string' ? t.scope : '',
  };
}

export function tokenProvider(store: CredentialStore, request: Fetch = fetch) {
  let pending: Promise<string> | undefined;
  return async (): Promise<string> => {
    if (pending) return pending;
    const c = await store.read();
    if (c.expiresAt > Date.now() + 60_000) return c.accessToken;
    // Serialize refresh within a process and across Claude/Codex processes.
    if (pending) return pending;
    pending = store.locked(async () => {
      const latest = await store.read();
      if (latest.expiresAt > Date.now() + 60_000) return latest.accessToken;
      if (!latest.refreshToken)
        throw new XError('No refresh token. Run x-plugin auth login again.');
      const next = await tokenRequest(
        latest.clientId,
        { grant_type: 'refresh_token', refresh_token: latest.refreshToken },
        request,
      );
      next.refreshToken ??= latest.refreshToken;
      next.scope ||= latest.scope;
      await store.write(next);
      return next.accessToken;
    });
    try {
      return await pending;
    } finally {
      pending = undefined;
    }
  };
}

export async function login(
  store: CredentialStore,
  clientId: string,
  write = false,
  request: Fetch = fetch,
  onAuthorize: (url: string) => void = (url) => {
    process.stderr.write(`Open this URL in your browser:\n${url}\n`);
  },
) {
  const redirectUri = 'http://127.0.0.1:8787/callback';
  const flow = authorization(clientId, redirectUri, write);
  await store.locked(
    () =>
      new Promise<void>((resolve, reject) => {
        let claimed = false;
        const finish = (error?: Error) => {
          clearTimeout(timer);
          server.close();
          server.closeAllConnections();
          error ? reject(error) : resolve();
        };
        const server = createServer(async (req, res) => {
          res.setHeader('Cache-Control', 'no-store');
          if (req.headers.host !== '127.0.0.1:8787' || req.method !== 'GET') {
            res.writeHead(400).end('Invalid callback.');
            return;
          }
          const url = new URL(req.url || '/', redirectUri);
          if (url.pathname !== '/callback') {
            res.writeHead(404).end();
            return;
          }
          if (claimed || url.searchParams.get('state') !== flow.state) {
            res.writeHead(400).end('Invalid or expired state.');
            return;
          }
          const code = url.searchParams.get('code');
          if (!code || url.searchParams.has('error')) {
            res
              .writeHead(400)
              .end('Authorization was not completed.', () =>
                finish(new XError('X authorization was denied.')),
              );
            return;
          }
          claimed = true;
          clearTimeout(timer); // The bounded token request now owns the deadline.
          try {
            const credentials = await tokenRequest(
              clientId,
              {
                grant_type: 'authorization_code',
                code,
                redirect_uri: redirectUri,
                code_verifier: flow.verifier,
              },
              request,
            );
            await store.write(credentials);
            res.end('X connected. You can close this tab.', () => finish());
          } catch {
            res
              .writeHead(500)
              .end('Authorization failed. Return to the terminal.', () =>
                finish(
                  new XError(
                    'Could not complete X authorization. Verify the app settings and retry.',
                  ),
                ),
              );
          }
        });
        const timer = setTimeout(
          () => finish(new XError('Authorization timed out after five minutes.')),
          300_000,
        );
        server.on('error', () =>
          finish(
            new XError('Cannot listen on 127.0.0.1:8787. Check whether another login is running.'),
          ),
        );
        server.listen(8787, '127.0.0.1', () => onAuthorize(flow.url));
      }),
  );
}
