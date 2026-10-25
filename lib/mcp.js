// Stateless MCP (Streamable HTTP) endpoint helper + tool result helpers.
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { logError, redact, SECURITY_HEADERS } from './util.js';

export async function serveMcp(request, createServer) {
  if (request.method === 'POST') {
    // Be lenient with clients that omit the Accept values the spec requires (we always reply with JSON).
    const accept = request.headers.get('accept') || '';
    if (!accept.includes('application/json') || !accept.includes('text/event-stream')) {
      const headers = new Headers(request.headers);
      headers.set('accept', 'application/json, text/event-stream');
      request = new Request(request, { headers });
    }
    const server = createServer();
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless: every request is independent
      enableJsonResponse: true,      // plain JSON replies, no long-lived streams
    });
    await server.connect(transport);
    const res = await transport.handleRequest(request);
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  }
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { allow: 'POST, OPTIONS' } });
  }
  // GET (server-sent event stream) and DELETE (sessions) are not used by this stateless server.
  return new Response(JSON.stringify({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed: this MCP endpoint only accepts POST.' },
    id: null,
  }), { status: 405, headers: { 'content-type': 'application/json', allow: 'POST, OPTIONS', ...SECURITY_HEADERS } });
}

const asText = (data) => (typeof data === 'string' ? data : JSON.stringify(data));

// Wraps a tool implementation: returns JSON text on success and a readable
// error (isError) for setup problems, API errors and bad input.
export function tool(fn) {
  return async (args) => {
    try {
      return { content: [{ type: 'text', text: asText(await fn(args ?? {})) }] };
    } catch (err) {
      const known = ['SetupError', 'ApiError', 'InputError'].includes(err?.name);
      if (!known) logError('tool', err);
      const message = known ? err.message : `Unexpected error: ${redact(err?.message || String(err))}`;
      return { content: [{ type: 'text', text: message }], isError: true };
    }
  };
}
