import { test } from 'node:test';
import assert from 'node:assert/strict';
import { XClient } from '../dist/x-client.js';
import { createServer } from '../dist/server.js';
import { createMcpHandler } from '@modelcontextprotocol/server';

function fixture(
  response = {
    data: [{ id: '123', text: 'hello' }],
    meta: { next_token: 'next-page' },
    includes: { users: [{ id: '456', username: 'example' }] },
  },
) {
  const calls = [];
  const client = new XClient(
    async () => 'synthetic-token',
    false,
    async (url, init) => {
      calls.push({ url, init });
      return Response.json(response);
    },
  );
  return { client, calls, response };
}

test('search preserves X query operators and maps the opaque cursor without injecting query parameters', async () => {
  const { client, calls, response } = fixture();
  const query = '("machine learning" OR #AI) from:example lang:en -is:retweet has:links & test';
  assert.deepEqual(
    await client.searchPosts({
      query,
      pagination_token: 'opaque+/=&',
      max_results: 10,
      sort_order: 'relevancy',
      start_time: '2026-09-04T00:00:00Z',
      end_time: '2026-09-05T00:00:00Z',
    }),
    response,
  );
  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(url.pathname, '/2/tweets/search/recent');
  assert.equal(url.searchParams.get('query'), query);
  assert.equal(url.searchParams.get('next_token'), 'opaque+/=&');
  assert.equal(url.searchParams.has('pagination_token'), false);
  assert.equal(url.searchParams.get('max_results'), '10');
  assert.equal(url.searchParams.get('sort_order'), 'relevancy');
  assert.equal(url.searchParams.get('start_time'), '2026-09-04T00:00:00Z');
  assert.equal(url.searchParams.get('end_time'), '2026-09-05T00:00:00Z');
  assert.equal(url.searchParams.get('expansions'), 'author_id');
  assert.ok(url.searchParams.get('post.fields').includes('public_metrics'));
  assert.equal(init.method, 'GET');
  assert.equal(init.body, undefined);
});

test('search defaults to 20 results sorted by recency and does not fetch extra pages', async () => {
  const { client, calls } = fixture();
  await client.searchPosts({ query: 'typescript' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.searchParams.get('max_results'), '20');
  assert.equal(calls[0].url.searchParams.get('sort_order'), 'recency');
  assert.equal(calls[0].url.searchParams.has('start_time'), false);
});

test('single-post lookup preserves large numeric IDs and expanded author/long-form content', async () => {
  const payload = {
    data: { id: '1900000000000000001', note_post: { text: 'long text' } },
    includes: { users: [{ id: '456' }] },
  };
  const { client, calls } = fixture(payload);
  assert.deepEqual(await client.post(payload.data.id), payload);
  assert.equal(calls[0].url.pathname, '/2/tweets/1900000000000000001');
  assert.ok(calls[0].url.searchParams.get('post.fields').includes('note_post'));
});

test('user timeline maps date filters, exclusions, and cursor to the correct endpoint', async () => {
  const { client, calls } = fixture();
  await client.userPosts({
    user_id: '456',
    max_results: 5,
    exclude: ['replies', 'retweets'],
    pagination_token: 'cursor',
    start_time: '2026-01-01T00:00:00Z',
    end_time: '2026-09-01T00:00:00Z',
  });
  const url = calls[0].url;
  assert.equal(url.pathname, '/2/users/456/tweets');
  assert.equal(url.searchParams.get('exclude'), 'replies,retweets');
  assert.equal(url.searchParams.get('pagination_token'), 'cursor');
  assert.equal(url.searchParams.has('next_token'), false);
  assert.equal(url.searchParams.get('max_results'), '5');
  assert.equal(url.searchParams.get('start_time'), '2026-01-01T00:00:00Z');
  assert.equal(url.searchParams.get('end_time'), '2026-09-01T00:00:00Z');
  await client.userPosts({ user_id: '456', exclude: [], start_time: undefined });
  assert.equal(calls[1].url.searchParams.has('exclude'), false);
  assert.equal(calls[1].url.searchParams.has('start_time'), false);
});

test('invalid search filters and IDs are rejected before authentication or network access', () => {
  const { client, calls } = fixture();
  for (const args of [
    { query: ' ' },
    { query: 'x'.repeat(513) },
    { query: 'x', max_results: 9 },
    { query: 'x', max_results: 101 },
    { query: 'x', sort_order: 'popular' },
    { query: 'x', start_time: 'yesterday' },
    { query: 'x', start_time: '2026-02-30T00:00:00Z' },
    { query: 'x', start_time: '2026-09-05T00:00:00Z', end_time: '2026-09-04T00:00:00Z' },
    { query: 'x', surprise: 'ignored?' },
  ])
    assert.throws(() => client.searchPosts(args), /Invalid post search/);
  for (const id of ['../search/recent', '123?query=x', '1'.repeat(20), ''])
    assert.throws(() => client.post(id), /Invalid post ID/);
  for (const args of [
    { user_id: '@example' },
    { user_id: '456', max_results: 4 },
    { user_id: '456', exclude: ['likes'] },
  ])
    assert.throws(() => client.userPosts(args), /Invalid user posts/);
  assert.equal(calls.length, 0);
});

test('post access errors retain status without leaking an upstream response body or retrying', async () => {
  for (const status of [403, 404, 429]) {
    let calls = 0;
    const client = new XClient(
      async () => 'synthetic-token',
      false,
      async () => {
        calls++;
        return new Response('private upstream body', { status });
      },
    );
    await assert.rejects(
      client.post('123'),
      (error) => error.status === status && !error.message.includes('private'),
    );
    assert.equal(calls, 1);
  }
});

const meta = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'post-tests', version: '1' },
  'io.modelcontextprotocol/clientCapabilities': {},
};
async function rpc(handler, method, args = {}) {
  const response = await handler.fetch(
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': '2026-07-28',
        'Mcp-Method': method,
        ...(args.name ? { 'Mcp-Name': args.name } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { _meta: meta, ...args } }),
    }),
  );
  return response.json();
}

test('all three post tools are discoverable as read-only and execute through MCP', async () => {
  const { client, calls } = fixture();
  const handler = createMcpHandler(() => createServer(client));
  const list = await rpc(handler, 'tools/list');
  const tools = list.result.tools;
  for (const [name, args, path] of [
    ['x_search_posts', { query: 'typescript' }, '/2/tweets/search/recent'],
    ['x_get_post', { post_id: '123' }, '/2/tweets/123'],
    ['x_get_user_posts', { user_id: '456' }, '/2/users/456/tweets'],
  ]) {
    assert.equal(tools.find((t) => t.name === name).annotations.readOnlyHint, true);
    const result = await rpc(handler, 'tools/call', { name, arguments: args });
    assert.ok(!result.error, JSON.stringify(result));
    assert.ok(!result.result.isError, JSON.stringify(result));
    assert.match(JSON.stringify(result.result), /next-page/);
    assert.equal(calls.at(-1).url.pathname, path);
  }
  assert.equal(calls.length, 3);
  const invalid = await rpc(handler, 'tools/call', {
    name: 'x_search_posts',
    arguments: { query: 'x', max_results: 1 },
  });
  assert.ok(invalid.error || invalid.result?.isError);
  assert.equal(calls.length, 3);
});

test('errors-only X responses fail MCP calls while partial results remain available', async () => {
  for (const data of [undefined, [], [{ id: '123' }]]) {
    const client = new XClient(
      async () => 'token',
      false,
      async () => Response.json({ data, errors: [{ title: 'Unavailable' }] }),
    );
    const result = await rpc(
      createMcpHandler(() => createServer(client)),
      'tools/call',
      { name: 'x_search_posts', arguments: { query: 'test' } },
    );
    assert.equal(Boolean(result.result.isError), !data?.length);
    assert.match(JSON.stringify(result), /Unavailable/);
  }
});
