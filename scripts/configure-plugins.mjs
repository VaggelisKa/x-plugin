import { mkdir, writeFile } from 'node:fs/promises';
const root = new URL('../plugins/x-plugin/', import.meta.url);
const metadata = {
  name: 'x-plugin',
  version: '0.1.0',
  description:
    'Connect your X account to your agent: read DMs, draft replies, and optionally send messages.',
  author: { name: 'VaggelisKa' },
  repository: 'https://github.com/VaggelisKa/x-plugin',
  license: 'MIT',
  skills: './skills/',
};
await mkdir(new URL('.claude-plugin/', root), { recursive: true });
await writeFile(
  new URL('.claude-plugin/plugin.json', root),
  JSON.stringify(metadata, null, 2) + '\n',
);
await writeFile(
  new URL('.codex-plugin/plugin.json', root),
  JSON.stringify(
    {
      ...metadata,
      mcpServers: './.mcp.json',
      interface: {
        displayName: 'X Plugin',
        shortDescription: 'Read and reply to X direct messages.',
        longDescription: metadata.description,
        developerName: 'VaggelisKa',
        category: 'Productivity',
        capabilities: ['Read', 'Write'],
        defaultPrompt: 'Review my recent X DMs and help me draft replies.',
      },
    },
    null,
    2,
  ) + '\n',
);
await writeFile(
  new URL('.mcp.json', root),
  JSON.stringify({ mcpServers: { x: { command: 'x-plugin', args: ['serve'] } } }, null, 2) + '\n',
);
