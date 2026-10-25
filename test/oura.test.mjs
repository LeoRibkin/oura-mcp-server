// End-to-end tests with a mocked Oura API and an in-memory token store.
// No network access, no real accounts and no real data are used.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const BASE = 'https://app.test';
const SECRET = 'oura_test_secret_abcdefghijklmnop';
const TZ = 'America/New_York';
Object.assign(process.env, { PUBLIC_BASE_URL: BASE, OURA_PATH_SECRET: SECRET, TIMEZONE: TZ });

const { handle } = await import('../lib/app.js');
const oura = await import('../lib/oura.js');
const util = await import('../lib/util.js');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');

// ------------------------------------------------------------ mock Oura
const O = { valid: new Set(['o-access-1']), refreshValid: new Set(), tokenCalls: 0, seq: 1, lastChallenge: null };
const days = (from, n) => Array.from({ length: n }, (_, i) => util.addDays(from, i));
async function ouraMock(url, init) {
  if (url.href === 'https://api.ouraring.com/oauth/token') {
    O.tokenCalls++;
    const p = new URLSearchParams(init.body);
    assert.equal(p.get('client_id'), 'o-client-id');
    assert.equal(p.get('client_secret'), 'o-client-secret');
    if (p.get('grant_type') === 'authorization_code') {
      assert.equal(util.pkceChallenge(p.get('code_verifier')), O.lastChallenge);
      assert.equal(p.get('redirect_uri'), `${BASE}/oauth/oura/callback`);
      O.refreshValid.add('o-refresh-1');
      return Response.json({ token_type: 'bearer', access_token: 'o-access-1', refresh_token: 'o-refresh-1', expires_in: 2591999 });
    }
    if (p.get('grant_type') === 'refresh_token') {
      const rt = p.get('refresh_token');
      if (!O.refreshValid.has(rt)) return Response.json({ error: 'invalid_grant' }, { status: 400 });
      O.refreshValid.delete(rt); // single use, like the real API
      await util.sleep(50);
      O.seq++;
      O.valid.add(`o-access-${O.seq}`); O.refreshValid.add(`o-refresh-${O.seq}`);
      return Response.json({ token_type: 'bearer', access_token: `o-access-${O.seq}`, refresh_token: `o-refresh-${O.seq}`, expires_in: 2591999 });
    }
  }
  assert.equal(url.origin, 'https://api.ouraring.com');
  const token = init?.headers?.authorization?.replace('Bearer ', '');
  if (!O.valid.has(token)) return Response.json({ detail: 'unauthorized' }, { status: 401 });
  const name = url.pathname.replace('/v2/usercollection/', '');
  const q = url.searchParams;
  if (name === 'personal_info') return Response.json({ id: 'u1', age: 40, weight: 80, height: 1.8, biological_sex: 'male', email: 'me@example.com' });
  if (name === 'heartrate') {
    const s = Date.parse(q.get('start_datetime')); const e = Date.parse(q.get('end_datetime'));
    const all = [];
    for (let t = s; t < e; t += 300_000) all.push({ bpm: 50 + (t / 300_000) % 30, source: (new Date(t).getUTCHours() < 4) ? 'sleep' : 'awake', timestamp: new Date(t).toISOString().replace('.000Z', '+00:00') });
    const start = Number(q.get('next_token') || 0);
    return Response.json({ data: all.slice(start, start + 1000), next_token: start + 1000 < all.length ? String(start + 1000) : null });
  }
  // Daily collections: end_date is exclusive, like the real API sometimes behaves.
  const from = q.get('start_date'); const to = q.get('end_date');
  // Sleep: the real API filters by the UTC date the sleep started (the night before `day`).
  const ds = name === 'sleep' ? days(util.addDays(from, 1), util.daysBetween(from, to)) : days(from, util.daysBetween(from, to));
  const mk = {
    daily_sleep: (d) => ({ id: `ds-${d}`, day: d, score: 80, contributors: { deep_sleep: 70 }, timestamp: `${d}T00:00:00-04:00` }),
    sleep: (d) => ({ id: `s-${d}`, day: d, type: 'long_sleep', bedtime_start: `${util.addDays(d, -1)}T23:10:00-04:00`, bedtime_end: `${d}T07:05:00-04:00`, total_sleep_duration: 25200, average_hrv: 45, lowest_heart_rate: 52, hrv: { interval: 300, items: [40, 41] }, heart_rate: { interval: 300, items: [55, 54] }, movement_30_sec: '1111', sleep_phase_5_min: '4422', readiness: { score: 77 } }),
    daily_readiness: (d) => ({ id: `r-${d}`, day: d, score: 84, temperature_deviation: 0.1, contributors: { hrv_balance: 80 } }),
    daily_activity: (d) => ({ id: `a-${d}`, day: d, score: 90, steps: 9000, class_5_min: '000', met: { interval: 60, items: [1, 2] } }),
    daily_stress: (d) => ({ id: `st-${d}`, day: d, stress_high: 3600, recovery_high: 7200, day_summary: 'normal' }),
    workout: (d) => ({ id: `w-${d}`, day: d, activity: 'walking', calories: 200, start_datetime: `${d}T18:00:00-04:00`, end_datetime: `${d}T18:40:00-04:00`, intensity: 'moderate', source: 'autodetected' }),
  }[name];
  if (!mk) throw new Error(`Unmocked Oura call ${url}`);
  return Response.json({ data: ds.map(mk), next_token: null });
}

// ------------------------------------------------------------ fetch router
globalThis.fetch = async (input, init = {}) => {
  const req = input instanceof Request ? input : null;
  const url = new URL(req ? req.url : String(input));
  if (url.origin === BASE) return handle(req && !init.method ? req : new Request(url, init));
  const headers = Object.fromEntries(new Headers(init.headers || req?.headers || {}).entries());
  const norm = { ...init, headers, body: init.body ?? (req ? await req.text() : undefined) };
  if (url.hostname.endsWith('ouraring.com')) return ouraMock(url, norm);
  throw new Error(`Unexpected outbound request: ${url}`);
};

// In-memory replacement for the Vercel Blob token store.
let stored = null; let writes = 0;
oura.tokenStore.read = async () => stored;
oura.tokenStore.write = async (v) => { writes++; stored = v; };

const get = (path, headers = {}) => handle(new Request(BASE + path, { headers }));
async function mcpClient(path) {
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(BASE + path)));
  return client;
}
const call = async (client, name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content?.[0]?.text ?? '';
  let json;
  try { json = JSON.parse(text); } catch { json = null; }
  return { isError: Boolean(r.isError), text, json };
};

// ------------------------------------------------------------ routing
await test('home page, unknown paths and wrong secrets', async () => {
  const home = await get('/');
  assert.equal(home.status, 200);
  assert.equal(await home.text(), 'Private service.');
  assert.equal((await get('/nope')).status, 404);
  assert.equal((await get('/oura/wrong-secret-0000000000000/setup')).status, 404);
  assert.equal((await get(`/tasks/${SECRET}/setup`)).status, 404);
  assert.equal((await get('/.well-known/oauth-protected-resource')).status, 404);
});

await test('home page explains a missing or unusable path secret without revealing it', async () => {
  try {
    process.env.OURA_PATH_SECRET = '';
    assert.match(await (await get('/')).text(), /OURA_PATH_SECRET environment variable is not set/);
    process.env.OURA_PATH_SECRET = 'short';
    assert.match(await (await get('/')).text(), /at least 16 characters/);
    process.env.OURA_PATH_SECRET = 'has spaces and/slashes 1234567890';
    const html = await (await get('/')).text();
    assert.match(html, /only letters, digits/);
    assert.ok(!html.includes('slashes'), 'must never echo the secret');
  } finally {
    process.env.OURA_PATH_SECRET = SECRET;
  }
});

await test('privacy and terms pages are generic', async () => {
  const privacy = await (await get('/privacy')).text();
  assert.match(privacy, /single-user/);
  assert.match(privacy, /the person who deploys this instance/);
  assert.match(await (await get('/terms')).text(), /the person who deploys this instance/);
});

await test('rewrite fallback path (?__p=)', async () => {
  const r = await get(`/api/index?__p=oura/${SECRET}/setup`);
  assert.equal(r.status, 200);
  assert.match(await r.text(), /Oura Ring connector/);
});

await test('MCP GET returns 405, trailing slash ok', async () => {
  assert.equal((await get(`/oura/${SECRET}/mcp/`)).status, 405);
});

// ------------------------------------------------------------ setup + OAuth
await test('setup page before config; connect blocked', async () => {
  const html = await (await get(`/oura/${SECRET}/setup`)).text();
  assert.match(html, /OURA_CLIENT_ID saved in Vercel/);
  assert.match(html, /btn disabled/);
  assert.match(html, /email personal daily heartrate workout/);
  assert.match(html, /https:\/\/app\.test\/oauth\/oura\/callback/);
  assert.ok(html.includes(`${BASE}/oura/${SECRET}/mcp`));
  assert.match(await (await get(`/oura/${SECRET}/connect`)).text(), /Not ready yet/);
});

Object.assign(process.env, { OURA_CLIENT_ID: 'o-client-id', OURA_CLIENT_SECRET: 'o-client-secret', BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_test' });
const oc = await mcpClient(`/oura/${SECRET}/mcp`);

await test('tools before connecting -> setup message', async () => {
  const r = await call(oc, 'daily_readiness');
  assert.equal(r.isError, true);
  assert.match(r.text, /not connected yet/);
});

await test('connect + callback stores encrypted tokens', async () => {
  const r = await get(`/oura/${SECRET}/connect`);
  const loc = new URL(r.headers.get('location'));
  assert.equal(loc.origin + loc.pathname, 'https://cloud.ouraring.com/oauth/authorize');
  assert.equal(loc.searchParams.get('scope'), 'email personal daily heartrate workout');
  assert.equal(loc.searchParams.get('response_type'), 'code');
  assert.equal(loc.searchParams.get('code_challenge_method'), 'S256');
  const cookie = r.headers.get('set-cookie');
  assert.match(cookie, /^__Host-oura_oauth=.+; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=900$/);
  O.lastChallenge = loc.searchParams.get('code_challenge');
  const state = encodeURIComponent(loc.searchParams.get('state'));
  const cb = await get(`/oauth/oura/callback?code=c1&state=${state}`, { cookie: cookie.split(';')[0] });
  const html = await cb.text();
  assert.equal(cb.status, 200, html);
  assert.match(html, /Test passed: connected to the Oura account me@example\.com/);
  assert.ok(stored && stored.startsWith('v1.'));
  assert.ok(!stored.includes('o-refresh-1') && !stored.includes('o-access-1'), 'tokens must be encrypted at rest');
  const rec = util.decryptJson(stored, util.deriveKey('o-client-secret', 'oura-token-store'));
  assert.equal(rec.refresh_token, 'o-refresh-1');
  // Replaying the callback from another browser (no cookie) must fail.
  const replay = await get(`/oauth/oura/callback?code=c1&state=${state}`);
  assert.equal(replay.status, 400);
  assert.match(await replay.text(), /Link expired/);
});

await test('tool list + every tool works', async () => {
  const { tools } = await oc.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ['daily_activity', 'daily_readiness', 'daily_sleep', 'daily_stress', 'heartrate', 'personal_info', 'sleep', 'workouts']);
  for (const t of tools) assert.equal(t.annotations.readOnlyHint, true);
  for (const t of tools.filter((x) => x.name !== 'personal_info')) {
    assert.ok(t.inputSchema.properties.start_date && t.inputSchema.properties.end_date, t.name);
  }
  const today = util.todayIn(TZ);
  for (const name of ['daily_sleep', 'daily_readiness', 'daily_activity', 'daily_stress', 'workouts', 'sleep']) {
    const r = await call(oc, name);
    assert.equal(r.isError, false, `${name}: ${r.text}`);
    assert.equal(r.json.count, 7, `${name} should return 7 days incl. today`);
    assert.equal(r.json.end_date, today);
    assert.equal(r.json.start_date, util.addDays(today, -6));
    assert.equal(r.json.data.at(-1).day, today);
    assert.equal(r.json.timezone, TZ);
  }
  const s = await call(oc, 'sleep', { start_date: today, end_date: today });
  assert.equal(s.json.count, 1);
  assert.equal(s.json.data[0].hrv, undefined);
  assert.equal(s.json.data[0].movement_30_sec, undefined);
  assert.equal(s.json.data[0].average_hrv, 45);
  const sFull = await call(oc, 'sleep', { start_date: today, end_date: today, include_timeseries: true });
  assert.deepEqual(sFull.json.data[0].hrv.items, [40, 41]);
  const a = await call(oc, 'daily_activity', { start_date: today, end_date: today });
  assert.equal(a.json.data[0].met, undefined);
  assert.equal(a.json.data[0].steps, 9000);
  const p = await call(oc, 'personal_info');
  assert.equal(p.json.email, 'me@example.com');
  const bad = await call(oc, 'daily_sleep', { start_date: '2026-10-10', end_date: '2026-10-01' });
  assert.equal(bad.isError, true);
});

await test('heartrate granularity + pagination', async () => {
  let r = await call(oc, 'heartrate', { start_date: '2026-10-10', end_date: '2026-10-16' });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.json.granularity, 'daily');
  assert.equal(r.json.data.length, 7);
  assert.equal(r.json.data[0].period, '2026-10-10');
  assert.equal(r.json.data[0].samples, 288);
  assert.equal(r.json.start, '2026-10-10T00:00:00-04:00');
  r = await call(oc, 'heartrate', { start_date: '2026-10-16', end_date: '2026-10-16' });
  assert.equal(r.json.granularity, 'hourly');
  assert.equal(r.json.data.length, 24);
  assert.equal(r.json.data[0].period, '2026-10-16 00:00');
  r = await call(oc, 'heartrate', { start_datetime: '2026-10-16T06:00:00-04:00', end_datetime: '2026-10-16T08:00:00-04:00' });
  assert.equal(r.json.granularity, 'raw');
  assert.equal(r.json.data.length, 24);
  assert.equal(r.json.data[0].time, '2026-10-16T06:00:00-04:00');
  r = await call(oc, 'heartrate', { start_date: '2026-09-01', end_date: '2026-10-16' });
  assert.equal(r.isError, true);
  assert.match(r.text, /Maximum is 31 days/);
});

await test('expired access token -> single refresh, rotated token saved', async () => {
  const key = util.deriveKey('o-client-secret', 'oura-token-store');
  const rec = util.decryptJson(stored, key);
  stored = util.encryptJson({ ...rec, expires_at: Date.now() - 1000 }, key);
  // Simulate a revoked access token (401) so both parallel calls must refresh.
  O.valid.delete('o-access-1');
  const w = writes; const calls = O.tokenCalls;
  const [r1, r2] = await Promise.all([call(oc, 'daily_readiness'), call(oc, 'daily_sleep')]);
  assert.equal(r1.isError, false, r1.text);
  assert.equal(r2.isError, false, r2.text);
  const now = util.decryptJson(stored, key);
  assert.equal(now.refresh_token, `o-refresh-${O.seq}`);
  assert.ok(O.tokenCalls - calls <= 2, 'at most one losing refresh attempt');
  assert.ok(writes > w);
  assert.ok(!O.refreshValid.has('o-refresh-1'), 'the old refresh token is used up');
});

await test('revoked refresh token -> clear reconnect message', async () => {
  O.valid.clear(); O.refreshValid.clear();
  const r = await call(oc, 'personal_info');
  assert.equal(r.isError, true);
  assert.match(r.text, /Connect Oura account/);
});

await test('setup page shows connected + error state', async () => {
  const html = await (await get(`/oura/${SECRET}/setup`)).text();
  assert.match(html, /Oura account connected/);
  assert.match(html, /Connection test failed/);
});

await oc.close();

// ------------------------------------------------------------ helpers
await test('date helpers across daylight-saving changes', () => {
  assert.equal(util.zonedToUtc('2026-07-01', '00:00:00', TZ).toISOString(), '2026-07-01T04:00:00.000Z');
  assert.equal(util.zonedToUtc('2026-12-01', '00:00:00', TZ).toISOString(), '2026-12-01T05:00:00.000Z');
  assert.equal(util.zonedToUtc('2026-03-08', '00:00:00', TZ).toISOString(), '2026-03-08T05:00:00.000Z');
  assert.equal(util.zonedToUtc('2026-03-09', '00:00:00', TZ).toISOString(), '2026-03-09T04:00:00.000Z');
  assert.equal(util.toLocalIso(new Date('2026-12-01T10:00:00Z'), TZ), '2026-12-01T05:00:00-05:00');
  assert.equal(util.toLocalIso(new Date('2026-12-01T10:00:00Z'), 'UTC'), '2026-12-01T10:00:00+00:00');
  const r = util.resolveDateRange(undefined, '2026-03-02', { tz: 'UTC' });
  assert.deepEqual([r.startDate, r.endDate, r.days], ['2026-02-24', '2026-03-02', 7]);
  assert.throws(() => util.resolveDateRange('2026-13-01', undefined, { tz: 'UTC' }));
});

await test('invalid TIMEZONE falls back to UTC; logs are redacted', () => {
  try {
    process.env.TIMEZONE = 'Not/A_Zone';
    assert.equal(util.userTimeZone(), 'UTC');
  } finally {
    process.env.TIMEZONE = TZ;
  }
  assert.equal(util.redact('Bearer abcdefghijklmnopqrstuvwxyz123456 ok'), 'Bearer [redacted] ok');
});
