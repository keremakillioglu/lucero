/**
 * Minimal real Streamable HTTP MCP server for tests that need a genuine HTTP stack
 * (no mocked transports). Exposes one `echo` tool and tracks sessions per connection.
 */
import http from 'http';
import { randomUUID } from 'crypto';
import express from 'express';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Socket } from 'net';

export interface TestServer {
  url: string;
  httpServer: http.Server;
  close: () => Promise<void>;
}

function trackSockets(httpServer: http.Server): () => Promise<void> {
  const sockets = new Set<Socket>();
  httpServer.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  return () =>
    new Promise<void>((resolve) => {
      for (const socket of sockets) {
        socket.destroy();
      }
      sockets.clear();
      httpServer.close(() => resolve());
    });
}

export function startMCPServer(): Promise<TestServer> {
  const app = express();
  app.use(express.json());

  const transports: Record<string, StreamableHTTPServerTransport> = {};

  function createServer(): McpServer {
    const server = new McpServer({ name: 'test-server', version: '1.0.0' });
    server.tool('echo', 'echoes input', { message: z.string() }, async (args) => {
      const msg = (args as Record<string, string>).message ?? '';
      return { content: [{ type: 'text', text: msg }] };
    });
    return server;
  }

  app.all('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (sessionId && transports[sessionId]) {
      await transports[sessionId].handleRequest(req, res, req.body);
      return;
    }

    if (!sessionId && isInitializeRequest(req.body)) {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          transports[sid] = transport;
        },
      });
      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) {
          delete transports[sid];
        }
      };
      const server = createServer();
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    if (req.method === 'GET') {
      res.status(404).send('Not Found');
      return;
    }

    res.status(400).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Bad Request: No valid session ID provided' },
      id: null,
    });
  });

  return new Promise((resolve) => {
    const httpServer = app.listen(0, '127.0.0.1', () => {
      const destroySockets = trackSockets(httpServer);
      const addr = httpServer.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${addr.port}/mcp`,
        httpServer,
        close: async () => {
          for (const t of Object.values(transports)) {
            t.close().catch(() => {});
          }
          await destroySockets();
        },
      });
    });
  });
}
