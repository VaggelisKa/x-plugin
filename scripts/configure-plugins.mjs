import { mkdir, readFile, writeFile } from 'node:fs/promises';
const root = new URL('../plugins/x-plugin/', import.meta.url);
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const metadata = {
  name: 'x-plugin',
  version: pkg.version,
  description:
    'Connect your X account to your agent: search posts, read DMs, draft replies, and optionally send messages.',
  author: { name: 'VaggelisKa' },
  repository: 'https://github.com/VaggelisKa/x-plugin',
  license: 'MIT',
  skills: './skills/',
};
await mkdir(new URL('.claude-plugin/', root), { recursive: true });
await mkdir(new URL('.codex-plugin/', root), { recursive: true });
await writeFile(
  new URL('.claude-plugin/plugin.json', root),
  JSON.stringify(metadata, null, 2) + '\n',
);
await writeFile(
  new URL('.codex-plugin/plugin.json', root),
  JSON.stringify(
    {
      ...metadata,
      mcpServers: {
        x: { command: 'node', args: ['runtime/x-plugin.cjs', 'serve'], cwd: '.' },
      },
      interface: {
        displayName: 'X Plugin',
        shortDescription: 'Search posts and manage X direct messages.',
        longDescription: metadata.description,
        developerName: 'VaggelisKa',
        category: 'Productivity',
        capabilities: ['Read', 'Write'],
        defaultPrompt: ['Review my recent X DMs and help me draft replies.'],
      },
    },
    null,
    2,
  ) + '\n',
);
await writeFile(
  new URL('.mcp.json', root),
  JSON.stringify(
    {
      mcpServers: {
        x: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/runtime/x-plugin.cjs', 'serve'] },
      },
    },
    null,
    2,
  ) + '\n',
);

for (const [path, catalog] of [
  [
    '.claude-plugin/marketplace.json',
    {
      name: 'x-plugin',
      owner: metadata.author,
      plugins: [
        {
          name: metadata.name,
          source: './plugins/x-plugin',
          description: metadata.description,
          version: metadata.version,
        },
      ],
    },
  ],
  [
    '.agents/plugins/marketplace.json',
    {
      name: 'x-plugin',
      interface: { displayName: 'X Plugin' },
      plugins: [
        {
          name: metadata.name,
          source: { source: 'local', path: './plugins/x-plugin' },
          policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
          category: 'Productivity',
        },
      ],
    },
  ],
]) {
  const url = new URL(`../${path}`, import.meta.url);
  await mkdir(new URL('./', url), { recursive: true });
  await writeFile(url, JSON.stringify(catalog, null, 2) + '\n');
}
