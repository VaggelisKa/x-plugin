import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readJson } from '../body.js';

/** compare-and-swap is the only mutation: one-use codes and refreshes are atomic. */
export interface Store {
  get(key: string): Promise<string | null>;
  cas(key: string, expected: string | null, next: string | null, ttl: number): Promise<boolean>;
  limit(key: string, maximum: number, seconds: number): Promise<boolean>;
}

export class RedisStore implements Store {
  constructor(
    private url: string,
    private token: string,
    private request = fetch,
  ) {
    const parsed = new URL(url);
    if (
      parsed.protocol !== 'https:' ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    )
      throw new Error('Redis requires an HTTPS REST URL.');
  }
  private async command(args: (string | number)[]) {
    const response = await this.request(this.url, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(8_000),
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    if (!response.ok) throw new Error('Credential storage unavailable.');
    const value = (await readJson(response, 128 * 1024)) as { result?: unknown; error?: unknown };
    if (!value || value.error || !('result' in value))
      throw new Error('Credential storage unavailable.');
    return value.result;
  }
  async get(key: string) {
    const value = await this.command(['GET', key]);
    if (value !== null && typeof value !== 'string') throw new Error('Invalid storage response.');
    return value;
  }
  async cas(key: string, expected: string | null, next: string | null, ttl: number) {
    return (
      (await this.command([
        'EVAL',
        "local v=redis.call('GET',KEYS[1]); if (ARGV[1]=='absent' and v) or (ARGV[1]=='present' and v~=ARGV[2]) then return 0 end; if ARGV[3]=='delete' then redis.call('DEL',KEYS[1]) else redis.call('SET',KEYS[1],ARGV[4],'EX',ARGV[5]) end; return 1",
        1,
        key,
        expected === null ? 'absent' : 'present',
        expected ?? '',
        next === null ? 'delete' : 'set',
        next ?? '',
        Math.max(1, Math.ceil(ttl)),
      ])) === 1
    );
  }
  async limit(key: string, maximum: number, seconds: number) {
    return await this.command([
      'EVAL',
      "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end; return n",
      1,
      key,
      seconds,
    ]).then((value) => typeof value === 'number' && value <= maximum);
  }
}

/** Every record is authenticated against its namespace and key (no cross-user swaps). */
export class Vault {
  private key: Buffer;
  constructor(
    readonly store: Store,
    hexKey: string,
    private namespace: string,
  ) {
    if (!/^[a-fA-F0-9]{64}$/.test(hexKey))
      throw new Error('Encryption key must be 32 random bytes in hex.');
    this.key = Buffer.from(hexKey, 'hex');
  }
  keyFor(key: string) {
    return `x-plugin:${this.namespace}:${key}`;
  }
  seal(key: string, value: unknown) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(this.keyFor(key)));
    const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
  }
  open<T>(key: string, raw: string): T {
    const data = Buffer.from(raw, 'base64url');
    const cipher = createDecipheriv('aes-256-gcm', this.key, data.subarray(0, 12));
    cipher.setAAD(Buffer.from(this.keyFor(key)));
    cipher.setAuthTag(data.subarray(12, 28));
    return JSON.parse(
      Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString('utf8'),
    );
  }
  async read<T>(key: string) {
    const raw = await this.store.get(this.keyFor(key));
    return raw === null ? null : { raw, value: this.open<T>(key, raw) };
  }
  async create(key: string, value: unknown, ttl: number) {
    if (!(await this.store.cas(this.keyFor(key), null, this.seal(key, value), ttl)))
      throw new Error('Record already exists.');
  }
  async replace(key: string, raw: string, value: unknown | null, ttl: number) {
    return this.store.cas(
      this.keyFor(key),
      raw,
      value === null ? null : this.seal(key, value),
      ttl,
    );
  }
}
