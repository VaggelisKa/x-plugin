import { createServer as httpServer, type IncomingMessage } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { createMcpHandler } from '@modelcontextprotocol/server';
import {
  toNodeHandler,
  localhostHostValidation,
  localhostOriginValidation,
} from '@modelcontextprotocol/node';
import { createServer } from './server.js';
import { XClient } from './x-client.js';

const BODY_LIMIT = 128 * 1024;
class RequestError extends Error {
  constructor(readonly status: number) {
    super('Invalid HTTP request.');
  }
}
function requestBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = () => {
      clearTimeout(timer);
      req.off('data', data);
      req.off('end', end);
      req.off('error', failed);
      req.off('aborted', failed);
    };
    const fail = (status: number) => {
      cleanup();
      req.pause();
      reject(new RequestError(status));
    };
    const failed = () => fail(400);
    const data = (chunk: Buffer) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        fail(413);
        return;
      }
      chunks.push(chunk);
    };
    const end = () => {
      cleanup();
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new RequestError(400));
      }
    };
    const timer = setTimeout(() => fail(408), 15_000);
    req.on('data', data);
    req.once('end', end);
    req.once('error', failed);
    req.once('aborted', failed);
  });
}

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
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        throw new RequestError(405);
      }
      if (
        req.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json' ||
        (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity')
      )
        throw new RequestError(415);
      if (Number(req.headers['content-length']) > BODY_LIMIT) throw new RequestError(413);
      await nodeHandler(req, res, await requestBody(req));
    } catch (error) {
      if (res.destroyed) return;
      if (!res.headersSent) {
        res.setHeader('Connection', 'close');
        res.writeHead(error instanceof RequestError ? error.status : 500);
      }
      res.end();
    }
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.listen(port, '127.0.0.1');
  return server;
}
