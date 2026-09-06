export type HostedConfig = {
  origin: string;
  xClientId: string;
  xClientSecret: string;
  allowedUserIds: string[];
  redisUrl: string;
  redisToken: string;
  encryptionKey: string;
};
export function hostedConfig(env = process.env): HostedConfig {
  function required(key: string) {
    const value = env[key];
    if (!value?.trim()) throw new Error(`Missing ${key}`);
    return value;
  }
  const origin = required('X_HOSTED_ORIGIN');
  const url = new URL(origin);
  if (url.protocol !== 'https:' || url.origin !== origin)
    throw new Error('Expected canonical HTTPS origin.');
  const allowedUserIds = required('X_ALLOWED_USER_IDS')
    .split(',')
    .map((id) => id.trim());
  if (!allowedUserIds.every((id) => /^\d{1,19}$/.test(id) || id === '*'))
    throw new Error('Invalid account allowlist.');
  return {
    origin,
    allowedUserIds,
    xClientId: required('X_CLIENT_ID'),
    xClientSecret: required('X_CLIENT_SECRET'),
    redisUrl: required('UPSTASH_REDIS_REST_URL'),
    redisToken: required('UPSTASH_REDIS_REST_TOKEN'),
    encryptionKey: required('X_TOKEN_ENCRYPTION_KEY'),
  };
}
