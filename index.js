// ---------- load env vars FIRST, before any other require ----------
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
// ---------- exit diagnostics ----------
process.on('SIGINT', () => {
  console.log('[signal] SIGINT received');
  process.exit(130);
});
process.on('SIGTERM', () => {
  console.log('[signal] SIGTERM received');
  process.exit(143);
});
process.on('SIGHUP', () => {
  console.log('[signal] SIGHUP received');
});

const express = require('express');
const { randomUUID } = require('node:crypto');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const {
  StreamableHTTPServerTransport
} = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { isInitializeRequest } = require('@modelcontextprotocol/sdk/types.js');
const {
  hostHeaderValidation
} = require('@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js');

const { registerHandlers } = require('./mcp-tools');

// ---------- global error handlers ----------
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});

const app = express();
app.use(express.json());

// ---------- request/response logging ----------
app.use((req, res, next) => {
  console.log(`[req] ${req.method} ${req.url}  content-type=${req.headers['content-type']}  session=${req.headers['mcp-session-id'] || '(none)'}`);
  res.on('finish', () => {
    console.log(`[res] ${req.method} ${req.url} -> ${res.statusCode}`);
  });
  res.on('close', () => {
    if (!res.writableEnded) {
      console.warn(`[res] ${req.method} ${req.url} CLOSED without finishing (client disconnected or hung)`);
    }
  });
  next();
});

// Reject requests whose Host header isn't in this allowlist.
// Protects against DNS rebinding attacks when binding to 0.0.0.0.
// app.use(hostHeaderValidation([
//   'localhost',
//   '127.0.0.1',
//   '192.168.12.217',       // ← run hostname -I on the pi. replace with your Pi's actual LAN IP
//   'Pi5A.local'          // ← or whatever hostname resolves to your Pi
// ]));

// Map of active sessions keyed by mcp-session-id header value.
const transports = {};

app.post('/mcp', async (req, res) => {
  console.log('[POST /mcp] body method:', req.body?.method, ' body id:', req.body?.id);

  const sessionId = req.headers['mcp-session-id'];
  let transport;

  try {
    if (sessionId && transports[sessionId]) {
      console.log('[POST /mcp] reusing existing transport for session', sessionId);
      transport = transports[sessionId];
    } else if (!sessionId && isInitializeRequest(req.body)) {
      console.log('[POST /mcp] new initialize request - creating transport');
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (newSessionId) => {
          console.log('[POST /mcp] onsessioninitialized fired, sessionId=', newSessionId);
          transports[newSessionId] = transport;
        }
      });

      transport.onclose = () => {
        console.log('[POST /mcp] transport.onclose for session', transport.sessionId);
        if (transport.sessionId) {
          delete transports[transport.sessionId];
        }
      };

      const mcpServer = new Server(
        { name: 'bluebeam-mcp', version: '1.0.0' },
        { capabilities: { tools: {} } }
      );

      registerHandlers(mcpServer);
      await mcpServer.connect(transport);
    } else if (sessionId && !transports[sessionId]) {
      // Stale or unknown session ID. Tell the client to re-initialize.
      // Per MCP Streamable HTTP spec, 404 signals the client to start a new session.
      console.log('[POST /mcp] unknown session, returning 404 to force re-init:', sessionId);
      res.status(404).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Session not found' },
        id: req.body?.id ?? null
      });
      return;
    } else {
      // No session ID and not an initialize request.
      console.log('[POST /mcp] rejecting: sessionId=', sessionId, 'isInit=', isInitializeRequest(req.body));
      res.status(400).json({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Bad Request: no valid session ID provided'
        },
        id: null
      });
      return;
    }

    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('[POST /mcp] ERROR in handler:', err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error: ' + err.message },
        id: req.body?.id ?? null
      });
    } else if (!res.writableEnded) {
      res.end();
    }
  }
});

const handleSessionRequest = async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  console.log(`[${req.method} /mcp] session=${sessionId}`);

  if (!sessionId) {
    console.log(`[${req.method} /mcp] rejecting: missing session ID`);
    res.status(400).send('Missing session ID');
    return;
  }

  if (!transports[sessionId]) {
    // Stale/unknown session — 404 tells the client to re-initialize.
    console.log(`[${req.method} /mcp] unknown session, returning 404 to force re-init:`, sessionId);
    res.status(404).send('Session not found');
    return;
  }

  const transport = transports[sessionId];
  try {
    await transport.handleRequest(req, res);
  } catch (err) {
    console.error(`[${req.method} /mcp] ERROR:`, err);
    if (!res.headersSent) res.status(500).end();
    else if (!res.writableEnded) res.end();
  }
};

app.get('/mcp', handleSessionRequest);
app.delete('/mcp', handleSessionRequest);

// ---------- listen ----------
const server = app.listen(3000, () => {
  console.log('Model Context Protocol server (Streamable HTTP) running on port 3000');
  console.log('[listen] server.listening =', server.listening);
  console.log('[listen] server.address() =', server.address());
});

server.on('error', (err) => {
  console.error('[listen] server error:', err);
});

server.on('close', () => {
  console.log('[listen] server closed');
});
