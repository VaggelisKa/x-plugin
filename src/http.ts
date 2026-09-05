import { createServer as httpServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { createMcpHandler } from '@modelcontextprotocol/server';
import {
  toNodeHandler,
  localhostHostValidation,
  localhostOriginValidation,
} from '@modelcontextprotocol/node';
import { createServer } from './server.js';
import { XClient } from './x-client.js';

// Single-user loopback transport. Public multi-user hosting requires a separate
// MCP OAuth resource server; X tokens must never be used as MCP credentials.
export function startHttp(client: XClient, secret: string, port = 8788) {
  if (secret.length < 32) throw new Error('X_MCP_HTTP_TOKEN must contain at least 32 characters.');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid HTTP port.');
  const handler = createMcpHandler(() => createServer(client));
  const nodeHandler = toNodeHandler(handler);
  const host = localhostHostValidation();
  const origin = localhostOriginValidation();
  const expected = Buffer.from(`Bearer ${secret}`);
  const server = httpServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!host(req, res) || !origin(req, res)) return;
    if (req.url !== '/mcp') {
      res.writeHead(404).end();
      return;
    }
    const supplied = Buffer.from(req.headers.authorization ?? '');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      res.writeHead(401).end();
      return;
    }
    try {
      await nodeHandler(req, res);
    } catch {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
  server.listen(port, '127.0.0.1');
  return server;
}
