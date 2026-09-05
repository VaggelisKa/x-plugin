import {
  searchPostsSchema,
  getPostSchema,
  userPostsSchema,
  postFields,
  type SearchPosts,
  type UserPosts,
} from './posts.js';

export class XError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryAfter?: string,
  ) {
    super(message);
    this.name = 'XError';
  }
}

export type TokenProvider = () => Promise<string>;
export type Page = { max_results?: number; pagination_token?: string };
export type Fetch = typeof fetch;

export class XClient {
  constructor(
    private token: TokenProvider,
    readonly allowWrite = false,
    private request: Fetch = fetch,
  ) {}

  private async call(
    path: string,
    query: Record<string, string> = {},
    text?: string,
  ): Promise<Record<string, unknown>> {
    const writing = text !== undefined;
    if (writing && !this.allowWrite)
      throw new XError('Sending is disabled. Restart with X_ALLOW_WRITE=true.');
    const url = new URL(`https://api.x.com/2/${path}`);
    url.search = new URLSearchParams(query).toString();
    const accessToken = await this.token();
    let response: Response;
    try {
      response = await this.request(url, {
        method: writing ? 'POST' : 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          ...(writing ? { 'Content-Type': 'application/json' } : {}),
        },
        body: writing ? JSON.stringify({ text }) : undefined,
        redirect: 'error',
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new XError(
        writing
          ? 'Delivery is unknown after a network failure. Check the conversation before retrying; do not resend automatically.'
          : 'X request failed or timed out. Try again later.',
      );
    }
    if (!response.ok) {
      const hints: Record<number, string> = {
        401: 'X authorization expired or was revoked. Run x-plugin auth login again.',
        402: 'X API credits are required. Check your developer account billing.',
        403: 'X denied access. Check app permissions, OAuth scopes, and account access.',
        429: 'X rate limit reached. Wait before retrying.',
      };
      const message = hints[response.status] ?? `X returned HTTP ${response.status}.`;
      throw new XError(
        message +
          (writing && response.status >= 500
            ? ' Delivery may be unknown; check before retrying.'
            : ''),
        response.status,
        response.headers.get('retry-after') ??
          response.headers.get('x-rate-limit-reset') ??
          undefined,
      );
    }
    try {
      const result: unknown = await response.json();
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error();
      return result as Record<string, unknown>;
    } catch {
      throw new XError(
        writing
          ? 'Invalid X response; delivery is unknown. Check before retrying.'
          : 'X returned an invalid response.',
      );
    }
  }

  searchPosts(input: SearchPosts) {
    const parsed = searchPostsSchema.safeParse(input);
    if (!parsed.success)
      throw new XError(
        'Invalid post search arguments. Check query, page size, sort order, and UTC date range.',
      );
    const { pagination_token, ...args } = parsed.data;
    return this.call('tweets/search/recent', {
      ...postFields,
      ...Object.fromEntries(
        Object.entries(args)
          .filter(([, value]) => value !== undefined)
          .map(([key, value]) => [key, String(value)]),
      ),
      ...(pagination_token ? { next_token: pagination_token } : {}),
    });
  }
  post(post_id: string) {
    if (!getPostSchema.safeParse({ post_id }).success)
      throw new XError('Invalid post ID. Use a numeric ID of at most 19 digits.');
    return this.call(`tweets/${post_id}`, postFields);
  }
  userPosts(input: UserPosts) {
    const parsed = userPostsSchema.safeParse(input);
    if (!parsed.success)
      throw new XError(
        'Invalid user posts arguments. Check user ID, page size, exclusions, and UTC date range.',
      );
    const { user_id, exclude, ...args } = parsed.data;
    return this.call(`users/${user_id}/tweets`, {
      ...postFields,
      ...Object.fromEntries(
        Object.entries(args)
          .filter(([, value]) => value !== undefined)
          .map(([key, value]) => [key, String(value)]),
      ),
      ...(exclude?.length ? { exclude: [...new Set(exclude)].join(',') } : {}),
    });
  }
  me() {
    return this.call('users/me');
  }
  user(username: string) {
    if (!/^[A-Za-z0-9_]{1,15}$/.test(username))
      throw new XError('Invalid X username. Omit the @ prefix.');
    return this.call(`users/by/username/${username}`);
  }
  messages(page: Page = {}, conversationId?: string, participantId?: string) {
    if (conversationId && participantId)
      throw new XError('Specify either a conversation or participant, not both.');
    if (conversationId && !/^\d+(?:-\d+)?$/.test(conversationId))
      throw new XError('Invalid conversation ID.');
    if (participantId && !/^\d+$/.test(participantId)) throw new XError('Invalid participant ID.');
    const limit = page.max_results ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new XError('max_results must be 1–100.');
    const path = conversationId
      ? `dm_conversations/${conversationId}/dm_events`
      : participantId
        ? `dm_conversations/with/${participantId}/dm_events`
        : 'dm_events';
    return this.call(path, {
      max_results: String(limit),
      'dm_event.fields': 'created_at,sender_id,text,dm_conversation_id',
      event_types: 'MessageCreate',
      ...(page.pagination_token ? { pagination_token: page.pagination_token } : {}),
    });
  }
  send(participantId: string, text: string) {
    if (!/^\d+$/.test(participantId)) throw new XError('Invalid participant ID.');
    if (!text.trim() || [...text].length > 10_000)
      throw new XError('Message must contain 1–10,000 characters.');
    return this.call(`dm_conversations/with/${participantId}/messages`, {}, text);
  }
}
