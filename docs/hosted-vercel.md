# Hosted X Plugin on Vercel

The hosted service runs independently of a user's computer. ChatGPT connects to
`https://YOUR_HOST/mcp`, obtains its own plugin tokens through browser OAuth, and
calls the same seven read tools as the local plugin. Hosted sending is disabled,
including when `X_ALLOW_WRITE` is set. This is the first hosted implementation;
live X authorization and ChatGPT installation must still be verified.

## Deploy

1. Import `VaggelisKa/x-plugin` into a dedicated Vercel project. Use the repository
   root, framework **Other**, and Node **24.x**. `vercel.json` defines the build,
   function, and routing. Deploy a preview of the hosted branch first.
2. Attach a dedicated **Upstash Redis** database through Vercel Marketplace. Use
   a regional database with strongly consistent primary reads and a **no-eviction**
   policy. This is authorization storage, not a disposable cache. Do not share a
   preview database or encryption key with production.
3. Set the environment variables listed below in Vercel's environment settings.
   Redeploy after adding or changing them. Never put secret values in chat, git,
   deployment URLs, or command-line arguments.
4. `GET /health` returns `200` only when configuration loads and Redis responds.
   Until configured, the service returns `503 service_not_configured` without
   exposing credentials or listing missing secret values.
5. Promote the verified deployment to a stable production hostname. Register that
   exact hostname in X and use the same origin in the environment. Preview
   protection should stay enabled. ChatGPT's production MCP endpoint must be
   reachable without Vercel preview authentication; OAuth protects the tools.

| Environment variable       | Value                                                                                                                      |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `X_HOSTED_ORIGIN`          | Canonical HTTPS origin, without a path or trailing slash                                                                   |
| `X_CLIENT_ID`              | OAuth 2.0 client ID from an X **Web App**                                                                                  |
| `X_CLIENT_SECRET`          | Confidential X app client secret                                                                                           |
| `X_ALLOWED_USER_IDS`       | Comma-separated numeric X IDs allowed to connect; use your own ID for initial testing. Explicit `*` enables other accounts |
| `X_TOKEN_ENCRYPTION_KEY`   | 32 cryptographically random bytes encoded as 64 hex characters                                                             |
| `UPSTASH_REDIS_REST_URL`   | Dedicated Redis REST endpoint                                                                                              |
| `UPSTASH_REDIS_REST_TOKEN` | Read/write Redis REST token                                                                                                |

Generate the encryption key in a password manager or a secure terminal and store
it in Vercel encrypted environment settings. Changing it invalidates existing
connections; retain it securely for recovery. Origin changes also invalidate
connections because records are namespaced and authenticated against the origin.

## Configure the X app

Use **Web App** (confidential client) with OAuth 2.0 enabled. Register exactly:

```text
https://YOUR_HOST/oauth/x/callback
```

The hosted login requests `tweet.read users.read dm.read offline.access`, uses
S256 PKCE, and authenticates token requests using the confidential client secret.
X API endpoint access and credits are still required. A Native App used by the
CLI is a different client configuration; create a separate Web App if retaining
the local setup.

## Connect in ChatGPT

1. Enable Developer mode in ChatGPT's **Settings → Security and login** where
   available. Open **Plugins → +** and set the MCP URL to `https://YOUR_HOST/mcp`.
2. Select OAuth and **Client ID Metadata Documents (CIMD)** when the builder
   offers a registration method. The service supports ChatGPT's stable CIMD
   identity with public-client PKCE (`none`), not DCR or client-secret login.
3. Confirm ChatGPT shows these exact values:
   - Client ID: `https://chatgpt.com/oauth/client.json`
   - Redirect: `https://chatgpt.com/connector_platform_oauth_redirect`
4. Enable the connection in a new conversation and authorize it. The plugin
   shows its own consent page, redirects to X, then returns to ChatGPT.
5. Test “Identify my connected X account”, a recent post search, and a DM read.
   Verify the expected account and confirm that `x_send_dm` is absent.

The server advertises issuer identification (`iss`), protected resource
discovery, S256 PKCE, and the `x.read` scope. The protected resource is the exact
MCP URL **including `/mcp`**. ChatGPT must send that resource on both authorization
and token requests. Only the stable ChatGPT client is supported in this first
hosted version. If the builder offers only a callback-specific client or DCR,
this version needs another registration adapter; do not weaken the redirect
allowlist or turn off authentication to work around it.

This connection tests the MCP tools. It does not install the repository's local
DM workflow skill or publish a listing in the public Plugin Directory. Complete
plugin packaging/submission is a separate distribution step after live checks.

## Storage and concurrency

- AES-256-GCM encrypts every credential, login, code, and token record. The Redis
  key and origin namespace are authenticated data, preventing record substitution.
- MCP access/refresh tokens are random and distinct from X tokens. Only their
  SHA-256 hashes appear in record keys. No X token reaches the agent.
- Each grant is isolated. The service creates an X client per authenticated MCP
  request; no user credentials live in a shared MCP singleton.
- Login records expire after ten minutes; authorization codes after two minutes;
  access tokens after at most one hour; grants and refresh tokens after 30 days.
  The user reconnects after 30 days. Expired data is removed by Redis TTL.
- Atomic compare-and-swap consumes codes and rotates refresh tokens. Reusing a
  consumed downstream refresh token revokes its grant. Losing a refresh response
  may require reconnecting; clients must not blindly replay refresh requests.
- X refresh marks the grant before calling X. Only one instance may rotate it.
  Failed/uncertain refreshes invalidate the grant. A process crash can leave a
  pending marker; reconnect rather than reusing a potentially consumed X token.
- Revocation deletes the grant and encrypted X credentials. Existing MCP tokens
  stop authorizing future requests; an already-started X request may finish.
  Removing a ChatGPT connection may not call revocation: revoke the app in X
  settings as well to invalidate X access immediately.
- Redis stores no DM/post bodies. The service emits no request bodies or token
  logs. Platform request logs may include callback URLs with short-lived codes;
  restrict log access and retention. Codes require PKCE or browser binding.
- Anonymous OAuth routes are limited to 60 requests/minute per route per
  deployment; MCP calls to 60/minute per grant. Add Vercel Firewall rules for
  deployment-specific abuse protection. These limits are deliberately modest for
  an initial private rollout, not a public-scale quota design.

## Verification

`npm run check` includes mocked end-to-end browser OAuth and real MCP transport
calls, account isolation, replay/PKCE/redirect rejection, encryption tampering,
revocation and concurrent refresh tests. They do not call live X or Upstash.

Before describing the integration as ready, verify `/health`, unauthorized MCP
discovery, actual browser login from ChatGPT, an X account lookup, post search,
DM read, and reconnect/revocation using the deployed service. Check that a second
account cannot access the first account's data if enabling public access.

References: [OpenAI authentication](https://developers.openai.com/plugins/build/auth),
[ChatGPT connection](https://developers.openai.com/plugins/deploy/connect-chatgpt),
[Vercel MCP](https://vercel.com/docs/mcp/deploy-mcp-servers-to-vercel),
[X OAuth](https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code),
[Upstash REST](https://upstash.com/docs/redis/features/restapi).
