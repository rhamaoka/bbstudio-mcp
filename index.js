const express = require('express');
const { randomuuid } = require('node:crypto');
const { server } = require('@modelcontextprotocol/sdk/server/index.js');
const {
  streamablehttpservertransport
} = require('@modelcontextprotocol/sdk/server/streamablehttp.js');
const { isinitializerequest } = require('@modelcontextprotocol/sdk/types.js');

const { registerhandlers } = require('./mcp-tools');

const app = express();
app.use(express.json());

// map of active sessions keyed by mcp-session-id header value.
// each entry holds the transport instance dedicated to that session.
const transports = {};

/**
 * handles all mcp requests on a single endpoint. the streamable http
 * transport multiplexes initialization, client-to-server messages,
 * and server-to-client streams over post and get to /mcp.
 */
app.post('/mcp', async (req, res) => {
  const sessionid = req.headers['mcp-session-id'];
  let transport;

  if (sessionid && transports[sessionid]) {
    // reuse existing transport for this session.
    transport = transports[sessionid];
  } else if (!sessionid && isinitializerequest(req.body)) {
    // new initialization request — create a fresh transport and server.
    transport = new streamablehttpservertransport({
      sessionidgenerator: () => randomuuid(),
      onsessioninitialized: (newsessionid) => {
        transports[newsessionid] = transport;
      }
    });

    // clean up when the transport closes.
    transport.onclose = () => {
      if (transport.sessionid) {
        delete transports[transport.sessionid];
      }
    };

    const server = new server(
      { name: 'bluebeam-mcp', version: '1.0.0' },
      { capabilities: { tools: {} } }
    );
    registerhandlers(server);
    await server.connect(transport);
  } else {
    // request lacks a valid session id and is not an initialization request.
    res.status(400).json({
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: 'bad request: no valid session id provided'
      },
      id: null
    });
    return;
  }

  await transport.handlerequest(req, res, req.body);
});

/**
 * get and delete on /mcp are used by the transport for the server-to-client
 * stream and for session (mcp connection session, not bluebeam session) termination, respectively. both require an existing
 * session id.
 */
const handlesessionrequest = async (req, res) => {
  const sessionid = req.headers['mcp-session-id'];
  if (!sessionid || !transports[sessionid]) {
    res.status(400).send('invalid or missing session id');
    return;
  }
  const transport = transports[sessionid];
  await transport.handlerequest(req, res);
};

app.get('/mcp', handlesessionrequest);
app.delete('/mcp', handlesessionrequest);

app.listen(3000, () => {
  console.log('model context protocol server (streamable http) running on port 3000');
});

