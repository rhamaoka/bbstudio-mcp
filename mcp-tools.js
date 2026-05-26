const axios = require('axios');
const {
  ListToolsRequestSchema,
  CallToolRequestSchema
} = require('@modelcontextprotocol/sdk/types.js');

const { getValidToken } = require('./auth-manager');

const API_HOST = 'https://studioapi.bluebeam.com/publicapi';

/**
 * Removes undefined and null values from a parameters object so that
 * axios does not serialize them as empty query string entries.
 */
const cleanParams = (obj = {}) =>
  Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined && v !== null)
  );

/**
 * Logs an outbound Bluebeam API request in a consistent format so we can
 * see exactly what URL, params, and (sanitized) headers were sent. Used by
 * every tool handler immediately before its axios call.
 */
const logOutbound = (method, url, params) => {
  console.log(
    `[bluebeam] ${method} ${url} params: ${JSON.stringify(params || {})}`
  );
};

/**
 * Builds a detailed, log-friendly error message from an axios error,
 * including the status code, the request URL, and the response body
 * when available. Falls back to a plain message for non-HTTP errors.
 */
const formatAxiosError = (e) => {
  let errorMessage = `Error: ${e.message}`;

  if (e.response) {
    errorMessage += `\nStatus: ${e.response.status} ${e.response.statusText || ''}`.trim();
    errorMessage += `\nURL: ${e.config?.method?.toUpperCase()} ${e.config?.url}`;
    if (e.config?.params) {
      errorMessage += `\nRequest params: ${JSON.stringify(e.config.params)}`;
    }
    if (e.response.data) {
      const body = typeof e.response.data === 'string'
        ? e.response.data
        : JSON.stringify(e.response.data, null, 2);
      errorMessage += `\nResponse body: ${body}`;
    }
  } else if (e.request) {
    errorMessage += `\nNo response received from ${e.config?.url}`;
  }

  return errorMessage;
};

/**
 * Tool schema definitions exposed to Model Context Protocol clients.
 * Each entry describes one Bluebeam Studio API operation the server supports.
 */
const TOOL_DEFINITIONS = [
  {
    name: 'get_sessions',
    description: 'List all Bluebeam Studio sessions the authenticated user owns or is attending',
    inputSchema: {
      type: 'object',
      properties: {
        orderby: { type: 'string', description: 'Field to order results by' },
        offset: { type: 'integer', description: 'Number of records to skip for pagination' },
        limit: { type: 'integer', description: 'Maximum number of records to return' },
        includeDeleted: { type: 'boolean', description: 'Whether to include deleted sessions' },
        ownedOrAttending: {
          type: 'string',
          enum: ['owned', 'Attending'],
          description: "Filter by ownership. Must be exactly 'Owned' or 'Attending' (case-sensitive). Omit to return both."
        }
      }
    }
  },
  {
    name: 'get_session_docs',
    description: 'List documents (files) within a specified Bluebeam Studio session',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'The Studio session ID' },
        offset: { type: 'integer', description: 'Number of records to skip for pagination' },
        limit: { type: 'integer', description: 'Maximum number of records to return' },
        includeDeleted: { type: 'boolean', description: 'Whether to include deleted files' }
      },
      required: ['sessionId']
    }
  },
  {
    name: 'get_doc_comments',
    description: 'Return a detailed list of markups (comments) on a specific session document',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'The Studio session ID' },
        docId: { type: 'string', description: 'The file (document) ID within the session' },
        offset: { type: 'integer', description: 'Number of records to skip for pagination' },
        limit: { type: 'integer', description: 'Maximum number of records to return' }
      },
      required: ['sessionId', 'docId']
    }
  },
  {
    name: 'get_doc_comment_statuses',
    description: 'Return the list of valid statuses for markups on a session document',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'The Studio session ID' },
        docId: { type: 'string', description: 'The file (document) ID within the session' }
      },
      required: ['sessionId', 'docId']
    }
  }
];

/**
 * Dispatch table mapping a tool name to the function that executes it.
 * Each handler receives the tool arguments and the Authorization headers
 * object, and returns the raw axios response data.
 */
const TOOL_HANDLERS = {
  get_sessions: async (args, headers) => {
    const { orderby, offset, limit, includeDeleted, ownedOrAttending } = args;
    const url = `${API_HOST}/v1/sessions`;
    const params = cleanParams({ orderby, offset, limit, includeDeleted, ownedOrAttending });
    logOutbound('GET', url, params);
    const res = await axios.get(url, { headers, params });
    return res.data;
  },

  get_session_docs: async (args, headers) => {
    const { sessionId, offset, limit, includeDeleted } = args;
    const url = `${API_HOST}/v1/sessions/${sessionId}/files`;
    const params = cleanParams({ offset, limit, includeDeleted });
    logOutbound('GET', url, params);
    const res = await axios.get(url, { headers, params });
    return res.data;
  },

  get_doc_comments: async (args, headers) => {
    const { sessionId, docId, offset, limit } = args;
    const url = `${API_HOST}/v2/sessions/${sessionId}/files/${docId}/markups/details`;
    const params = cleanParams({ offset, limit });
    logOutbound('GET', url, params);
    const res = await axios.get(url, { headers, params });
    return res.data;
  },

  get_doc_comment_statuses: async (args, headers) => {
    const { sessionId, docId } = args;
    const url = `${API_HOST}/v2/sessions/${sessionId}/files/${docId}/statuses`;
    logOutbound('GET', url, {});
    const res = await axios.get(url, { headers });
    return res.data;
  }
};

/**
 * Registers the ListTools and CallTool request handlers on a given
 * Model Context Protocol Server instance. This is the single entry
 * point the transport layer uses to wire tools into a server.
 */
function registerHandlers(server) {
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    const args = request.params.arguments || {};
    console.log(`[tool] ${toolName} args: ${JSON.stringify(args)}`);

    const handler = TOOL_HANDLERS[toolName];

    if (!handler) {
      return {
        content: [{ type: 'text', text: `Unknown tool: ${toolName}` }],
        isError: true
      };
    }

    try {
      const token = await getValidToken();
      const headers = { Authorization: `Bearer ${token}` };
      const data = await handler(args, headers);
      return { content: [{ type: 'text', text: JSON.stringify(data) }] };
    } catch (e) {
      const errorMessage = formatAxiosError(e);
      console.error('[Bluebeam MCP] Tool call failed:', errorMessage);
      return {
        content: [{ type: 'text', text: errorMessage }],
        isError: true
      };
    }
  });
}

module.exports = { registerHandlers };
