// Smoke test: starts the server on a local port and checks the MCP tool list over real HTTP.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const SECRET = 'test'.repeat(8); // made-up 32-character path secret
process.env.OURA_PATH_SECRET = SECRET;

const { handle } = await import('../lib/app.js');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');

const EXPECTED_TOOLS = [
  'daily_activity', 'daily_readiness', 'daily_sleep', 'daily_stress', 'heartrate', 'personal_info', 'sleep', 'workouts',
];

// Serves the Vercel-style fetch handler with Node's built-in HTTP server.
function listen() {
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
    }
    const hasBody = !['GET', 'HEAD'].includes(req.method);
    const response = await handle(new Request(`http://${req.headers.host}${req.url}`, {
      method: req.method, headers, body: hasBody ? Buffer.concat(chunks) : undefined,
    }));
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

let server;
let base;
before(async () => {
  server = await listen();
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.closeAllConnections();
  server.close();
});

test('MCP endpoint lists every Oura tool, all read-only', async () => {
  const client = new Client({ name: 'smoke-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/oura/${SECRET}/mcp`)));
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), EXPECTED_TOOLS);
  for (const t of tools) assert.equal(t.annotations?.readOnlyHint, true, `${t.name} must be read-only`);
  await client.close();
});

test('a wrong secret gets 404 and no tools', async () => {
  const res = await fetch(`${base}/oura/not-the-right-secret-000000/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  assert.equal(res.status, 404);
  assert.equal(await res.text(), 'Not found');
});
