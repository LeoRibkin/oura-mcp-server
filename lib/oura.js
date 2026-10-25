// Oura Ring (API v2, read-only): OAuth setup flow, encrypted token storage
// in a private Vercel Blob store (Oura refresh tokens are single-use), API
// client and MCP tools.
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { tool } from './mcp.js';
import { page, messagePage, statusList, copyBox, button, esc } from './pages.js';
import {
  env, baseUrl, userTimeZone, SetupError, ApiError, InputError, deriveKey, signState, verifyState,
  pkceVerifier, pkceChallenge, randomToken, readCookie, setCookie, redirect, readJson, safeEqual,
  encryptJson, decryptJson, resolveDateRange, addDays, toLocalIso, localParts, zonedToUtc, logError, sleep,
} from './util.js';

const AUTH_URL = 'https://cloud.ouraring.com/oauth/authorize';
const TOKEN_URL = 'https://api.ouraring.com/oauth/token';
const API = 'https://api.ouraring.com/v2/usercollection';
export const OURA_CALLBACK_PATH = '/oauth/oura/callback';
export const DEFAULT_OURA_SCOPES = 'email personal daily heartrate workout';
const COOKIE = '__Host-oura_oauth';
const STORE_PATH = 'oura/tokens.enc';

const cfg = () => ({ clientId: env('OURA_CLIENT_ID'), clientSecret: env('OURA_CLIENT_SECRET') });
const scopes = () => env('OURA_SCOPES') || DEFAULT_OURA_SCOPES;
const redirectUri = () => baseUrl() + OURA_CALLBACK_PATH;
const storageReady = () => Boolean(env('BLOB_READ_WRITE_TOKEN') || env('BLOB_STORE_ID'));
const oauthKey = () => deriveKey(cfg().clientSecret, 'oura-oauth');
const storeKey = () => deriveKey(cfg().clientSecret, 'oura-token-store');

// ---------------------------------------------------------------- token storage
// Replaceable (tests). Values are encrypted before they reach the store.
export const tokenStore = {
  async read() {
    const { get } = await import('@vercel/blob');
    let res;
    try {
      res = await get(STORE_PATH, { access: 'private', useCache: false });
    } catch (err) {
      if (err?.name === 'BlobNotFoundError') return null;
      throw err;
    }
    if (!res || res.statusCode !== 200 || !res.stream) return null;
    return new Response(res.stream).text();
  },
  async write(value) {
    const { put } = await import('@vercel/blob');
    await put(STORE_PATH, value, {
      access: 'private', addRandomSuffix: false, allowOverwrite: true, contentType: 'text/plain', cacheControlMaxAge: 60,
    });
  },
};

function requireConfig() {
  const { clientId, clientSecret } = cfg();
  const missing = [!clientId && 'OURA_CLIENT_ID', !clientSecret && 'OURA_CLIENT_SECRET'].filter(Boolean);
  if (missing.length) {
    throw new SetupError(`The Oura connector is not fully set up (missing in Vercel: ${missing.join(', ')}). Finish the steps on your Oura setup page.`);
  }
  if (!storageReady()) throw new SetupError('The Oura connector has no storage connected (Vercel Blob). Finish the steps on your Oura setup page.');
}

async function loadRecord() {
  const raw = await tokenStore.read();
  if (!raw) return null;
  try {
    return decryptJson(raw, storeKey());
  } catch {
    throw new SetupError('The saved Oura sign-in can\'t be read (the Oura client secret may have changed). Open your Oura setup page and click "Connect Oura account" again.');
  }
}

async function saveRecord(record) {
  const value = encryptJson(record, storeKey());
  for (let attempt = 1; ; attempt++) {
    try { return await tokenStore.write(value); } catch (err) {
      if (attempt >= 3) throw err;
      await sleep(300 * attempt);
    }
  }
}

class OAuthError extends Error {
  constructor(status, code) { super(`Oura token request failed (HTTP ${status}${code ? `, ${code}` : ''})`); this.name = 'OAuthError'; this.status = status; this.code = code; }
}

async function tokenRequest(params) {
  const { clientId, clientSecret } = cfg();
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...params }),
  });
  const data = (await readJson(res)) || {};
  if (!res.ok || !data.access_token) throw new OAuthError(res.status, data.error);
  return data;
}

const toRecord = (tok, previous = {}) => ({
  access_token: tok.access_token,
  refresh_token: tok.refresh_token || previous.refresh_token || null,
  expires_at: Date.now() + (Number(tok.expires_in) || 86_400) * 1000,
  connected_at: previous.connected_at || new Date().toISOString(),
  updated_at: new Date().toISOString(),
});

let memory = null; // decrypted record cached in this warm instance only

export async function getAccessToken(force = false) {
  requireConfig();
  const fresh = (r) => r && r.access_token && r.expires_at > Date.now() + 120_000;
  if (!force && fresh(memory)) return memory.access_token;
  const record = await loadRecord();
  if (!record) throw new SetupError('Oura is not connected yet. Open your Oura setup page and click "Connect Oura account".');
  if (!force && fresh(record)) { memory = record; return record.access_token; }
  if (!record.refresh_token) throw new SetupError('The Oura sign-in has expired. Open your Oura setup page and click "Connect Oura account" again.');
  let tok;
  try {
    tok = await tokenRequest({ grant_type: 'refresh_token', refresh_token: record.refresh_token });
  } catch (err) {
    // Refresh tokens are single-use: another instance may have just refreshed. Re-read before giving up.
    for (let i = 0; i < 3; i++) {
      await sleep(700);
      const again = await loadRecord();
      if (again && again.refresh_token !== record.refresh_token && fresh(again)) { memory = again; return again.access_token; }
    }
    if (err instanceof OAuthError && [400, 401].includes(err.status)) {
      throw new SetupError('Oura rejected the saved sign-in (it was revoked or expired). Open your Oura setup page and click "Connect Oura account" again.');
    }
    throw err;
  }
  const updated = toRecord(tok, record);
  await saveRecord(updated);
  memory = updated;
  return updated.access_token;
}

async function ouraGet(path, query = {}) {
  for (let attempt = 0; ; attempt++) {
    const token = await getAccessToken(attempt > 0);
    const url = new URL(API + path);
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' } });
    if (res.status === 401 && attempt === 0) continue; // token rejected: refresh once and retry
    const data = await readJson(res);
    if (res.ok) return data;
    if (res.status === 401) throw new SetupError('Oura rejected the sign-in. Open your Oura setup page and click "Connect Oura account" again.');
    if (res.status === 403) {
      throw new ApiError(403, 'Oura refused access (403). Either the Oura membership is not active, or this data type was not allowed '
        + 'when you connected. Reconnect on the Oura setup page and allow every requested data type.');
    }
    if (res.status === 429) throw new ApiError(429, 'Oura rate limit reached. Wait a few minutes and try again.');
    const detail = typeof data?.detail === 'string' ? data.detail : (data?.detail ? JSON.stringify(data.detail).slice(0, 300) : '');
    throw new ApiError(res.status, `Oura API error (HTTP ${res.status})${detail ? `: ${detail}` : ''}`);
  }
}

async function ouraGetAll(path, query, maxPages = 20) {
  const all = [];
  let next;
  for (let i = 0; i < maxPages; i++) {
    const data = await ouraGet(path, { ...query, next_token: next });
    all.push(...(data?.data || []));
    next = data?.next_token;
    if (!next) return { items: all, complete: true };
  }
  return { items: all, complete: false };
}

const omit = (obj, keys) => Object.fromEntries(Object.entries(obj).filter(([k]) => !keys.includes(k)));

// Fetches a daily collection for an inclusive local date range. Oura filters
// some endpoints by the UTC start time (in a time zone ahead of UTC, a night
// that began at 02:00 local time counts as the previous UTC day) and treats
// end_date as exclusive, so we ask for one extra day on each side and filter
// on the document's "day".
async function dailyCollection(name, { start_date, end_date }) {
  const tz = userTimeZone();
  const { startDate, endDate } = resolveDateRange(start_date, end_date, { tz });
  const { items, complete } = await ouraGetAll(`/${name}`, { start_date: addDays(startDate, -1), end_date: addDays(endDate, 1) });
  const data = items
    .filter((d) => !d.day || (d.day >= startDate && d.day <= endDate))
    .sort((a, b) => String(a.day || '').localeCompare(String(b.day || '')));
  return { meta: { start_date: startDate, end_date: endDate, timezone: tz, count: data.length, ...(complete ? {} : { truncated: true }) }, data };
}

// ---------------------------------------------------------------- MCP server
const range = {
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').optional()
    .describe('First day to include (YYYY-MM-DD, local date). Default: 6 days before end_date (7 days in total).'),
  end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').optional()
    .describe('Last day to include (YYYY-MM-DD, inclusive). Default: today.'),
};
const readOnly = { readOnlyHint: true, openWorldHint: true };

export function createServer() {
  const server = new McpServer(
    { name: 'oura', title: 'Oura Ring', version: '1.0.0' },
    {
      instructions: `Read-only access to the user's Oura Ring data (time zone ${userTimeZone()}). Every tool takes start_date/end_date `
        + '(YYYY-MM-DD, inclusive) and defaults to the last 7 days ending today. Sleep is filed under the day the user woke up, '
        + 'so "last night" = today\'s date; the main overnight session has type "long_sleep". Today\'s readiness has day = today. '
        + 'Durations are in seconds. If recent sleep or readiness is missing, the user may need to open the Oura app so the ring syncs.',
    },
  );

  server.registerTool('daily_sleep', {
    title: 'Daily sleep scores',
    description: 'Daily sleep score (0-100) and its contributors (deep sleep, efficiency, latency, REM, restfulness, timing, total sleep) for each day.',
    inputSchema: { ...range },
    annotations: readOnly,
  }, tool(async (args) => {
    const { meta, data } = await dailyCollection('daily_sleep', args);
    return { ...meta, data };
  }));

  server.registerTool('sleep', {
    title: 'Sleep sessions (detailed)',
    description: 'Detailed sleep sessions: bedtime_start / bedtime_end (bedtime and wake time), total, deep, REM and light sleep, '
      + 'awake time, efficiency, latency, average_hrv (ms), average_heart_rate and lowest_heart_rate (Oura\'s resting heart rate, bpm), '
      + 'breathing rate and the embedded readiness. Durations are in seconds. The main night has type "long_sleep" and is filed under '
      + 'the wake-up date. Set include_timeseries=true for the 5-minute HRV/heart-rate series and hypnogram.',
    inputSchema: {
      ...range,
      include_timeseries: z.boolean().optional().describe('Include 5-minute HRV and heart-rate samples and sleep-phase strings (large). Default false.'),
    },
    annotations: readOnly,
  }, tool(async ({ include_timeseries = false, ...args }) => {
    const { meta, data } = await dailyCollection('sleep', args);
    const heavy = ['heart_rate', 'hrv', 'movement_30_sec', 'sleep_phase_5_min', 'sleep_phase_30_sec', 'app_sleep_phase_5_min'];
    const sessions = data
      .filter((s) => s.type !== 'deleted')
      .map((s) => (include_timeseries ? s : omit(s, heavy)))
      .sort((a, b) => String(a.bedtime_start || '').localeCompare(String(b.bedtime_start || '')));
    return { ...meta, count: sessions.length, data: sessions };
  }));

  server.registerTool('daily_readiness', {
    title: 'Daily readiness',
    description: 'Daily readiness score (0-100), temperature deviation and contributors (HRV balance, resting heart rate, recovery index, sleep balance, previous night, activity balance, body temperature).',
    inputSchema: { ...range },
    annotations: readOnly,
  }, tool(async (args) => {
    const { meta, data } = await dailyCollection('daily_readiness', args);
    return { ...meta, data };
  }));

  server.registerTool('daily_activity', {
    title: 'Daily activity',
    description: 'Daily activity: activity score, steps, active/total calories, walking-equivalent distance (m), time spent in high/medium/low activity, sedentary and resting time (seconds), inactivity alerts and contributors.',
    inputSchema: {
      ...range,
      include_timeseries: z.boolean().optional().describe('Include the per-minute MET series and 5-minute activity classes (large). Default false.'),
    },
    annotations: readOnly,
  }, tool(async ({ include_timeseries = false, ...args }) => {
    const { meta, data } = await dailyCollection('daily_activity', args);
    return { ...meta, data: include_timeseries ? data : data.map((d) => omit(d, ['met', 'class_5_min'])) };
  }));

  server.registerTool('daily_stress', {
    title: 'Daily stress',
    description: 'Daily stress: seconds of high stress (stress_high), seconds of high recovery (recovery_high) and the day summary (restored / normal / stressful).',
    inputSchema: { ...range },
    annotations: readOnly,
  }, tool(async (args) => {
    const { meta, data } = await dailyCollection('daily_stress', args);
    return { ...meta, data };
  }));

  server.registerTool('workouts', {
    title: 'Workouts',
    description: 'Workouts (auto-detected and manually added): activity, start/end time, calories, distance (m), intensity and source.',
    inputSchema: { ...range },
    annotations: readOnly,
  }, tool(async (args) => {
    const { meta, data } = await dailyCollection('workout', args);
    return { ...meta, data };
  }));

  server.registerTool('heartrate', {
    title: 'Heart rate',
    description: 'Heart-rate samples (bpm) for a time range, measured by the ring through the day and night. By default it summarizes: '
      + 'raw samples for ranges up to 6 hours, hourly min/avg/max up to 3 days, daily min/avg/max beyond that. '
      + 'Use start_datetime/end_datetime for an exact window. Maximum range: 31 days.',
    inputSchema: {
      ...range,
      start_datetime: z.string().optional().describe('Exact start time, ISO 8601 (e.g. 2026-01-15T06:00:00+01:00). Overrides start_date.'),
      end_datetime: z.string().optional().describe('Exact end time, ISO 8601. Overrides end_date.'),
      granularity: z.enum(['auto', 'raw', 'hourly', 'daily']).optional().describe('"auto" (default), "raw" samples, or "hourly" / "daily" min/avg/max.'),
    },
    annotations: readOnly,
  }, tool(async ({ start_date, end_date, start_datetime, end_datetime, granularity = 'auto' }) => {
    const tz = userTimeZone();
    const { startDate, endDate } = resolveDateRange(start_date, end_date, { tz });
    const parse = (name, v) => {
      const d = new Date(v);
      if (Number.isNaN(d.getTime())) throw new InputError(`${name} must be an ISO 8601 date-time (got "${v}").`);
      return d;
    };
    const start = start_datetime ? parse('start_datetime', start_datetime) : zonedToUtc(startDate, '00:00:00', tz);
    let end = end_datetime ? parse('end_datetime', end_datetime) : zonedToUtc(addDays(endDate, 1), '00:00:00', tz);
    if (!end_datetime && end > new Date()) end = new Date();
    if (end <= start) throw new InputError('The end of the range must be after the start.');
    const hours = (end - start) / 3_600_000;
    if (hours > 31 * 24 + 1) throw new InputError('Heart-rate range is too long. Maximum is 31 days.');
    const { items, complete } = await ouraGetAll('/heartrate', { start_datetime: start.toISOString(), end_datetime: end.toISOString() }, 80);
    const samples = items
      .filter((r) => typeof r.bpm === 'number' && r.timestamp)
      .map((r) => ({ t: new Date(r.timestamp), bpm: r.bpm, source: r.source }))
      .sort((a, b) => a.t - b.t);
    const mode = granularity === 'auto' ? (hours <= 6 ? 'raw' : hours <= 72 ? 'hourly' : 'daily') : granularity;
    const stats = (list) => {
      let min = Infinity; let max = -Infinity; let sum = 0;
      const sources = {};
      for (const s of list) {
        if (s.bpm < min) min = s.bpm;
        if (s.bpm > max) max = s.bpm;
        sum += s.bpm;
        sources[s.source || 'unknown'] = (sources[s.source || 'unknown'] || 0) + 1;
      }
      return { min, avg: Math.round((sum / list.length) * 10) / 10, max, samples: list.length, sources };
    };
    const result = {
      timezone: tz, start: toLocalIso(start, tz), end: toLocalIso(end, tz), granularity: mode,
      ...(complete ? {} : { truncated: true }), summary: samples.length ? stats(samples) : null,
    };
    if (mode === 'raw') {
      const max = 2000;
      result.data = samples.slice(0, max).map((s) => ({ time: toLocalIso(s.t, tz), bpm: s.bpm, source: s.source }));
      if (samples.length > max) result.truncated = true;
    } else {
      const buckets = new Map();
      for (const s of samples) {
        const p = localParts(s.t, tz);
        const key = mode === 'hourly' ? `${p.date} ${p.hour}:00` : p.date;
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(s);
      }
      result.data = [...buckets.entries()].map(([period, list]) => ({ period, ...stats(list) }));
    }
    return result;
  }));

  server.registerTool('personal_info', {
    title: 'Personal info',
    description: 'The Oura account\'s personal info: age, weight (kg), height (m), biological sex and email. (Takes no date range.)',
    inputSchema: {},
    annotations: readOnly,
  }, tool(async () => ouraGet('/personal_info')));

  return server;
}

// ---------------------------------------------------------------- setup pages
export async function setupPage(prefix) {
  const { clientId, clientSecret } = cfg();
  const storage = storageReady();
  let connected = ['todo', 'Oura account connected', 'Click the button below once the items above are done.'];
  let test = null;
  if (clientId && clientSecret && storage) {
    try {
      const record = await loadRecord();
      if (record) {
        connected = ['ok', 'Oura account connected', `Since ${esc(String(record.connected_at || '').slice(0, 10))}`];
        try {
          const info = await ouraGet('/personal_info');
          const ready = await dailyCollection('daily_readiness', {});
          const last = ready.data[ready.data.length - 1];
          test = ['ok', 'Connection test passed', `Oura account ${esc(info?.email || info?.id || '')} &middot; `
            + (last ? `latest readiness score: ${esc(last.score)} (${esc(last.day)})` : 'no readiness data in the last 7 days')];
        } catch (err) {
          test = ['bad', 'Connection test failed', esc(err.message)];
        }
      }
    } catch (err) {
      connected = ['bad', 'Oura account connected', esc(err.message)];
    }
  }
  const rows = [
    [clientId ? 'ok' : 'todo', 'OURA_CLIENT_ID saved in Vercel'],
    [clientSecret ? 'ok' : 'todo', 'OURA_CLIENT_SECRET saved in Vercel'],
    [storage ? 'ok' : 'todo', 'Private storage connected (Vercel Blob)', storage ? '' : 'Create a private Blob store in Vercel (Storage tab), connect it to this project, then redeploy.'],
    connected,
    ...(test ? [test] : []),
  ];
  const ready = Boolean(clientId && clientSecret && storage);
  const body = `
    <h1>Oura Ring connector</h1>
    <p class="lead">Private setup page &mdash; don't share this link.</p>
    <div class="card">${statusList(rows)}</div>
    <div class="card">
      <h2>Connect your Oura account</h2>
      <p>Signs you in with Oura. Your Oura sign-in is then stored encrypted in your private Vercel storage and renewed automatically &mdash; nothing to copy.</p>
      ${button(`${prefix}/connect`, connected[0] === 'ok' ? 'Reconnect Oura account' : 'Connect Oura account', ready)}
      ${ready ? '' : '<p class="muted">Available once the first three items are done and the app is redeployed.</p>'}
    </div>
    <div class="card">
      <h2>Values for your Oura application</h2>
      <label>Redirect URI</label>${copyBox(redirectUri())}
      <label>Privacy policy URL</label>${copyBox(`${baseUrl()}/privacy`)}
      <label>Terms of service URL</label>${copyBox(`${baseUrl()}/terms`)}
      <label>Scopes to allow</label>${copyBox(scopes())}
      <label>Connector URL for Claude (keep private)</label>${copyBox(`${baseUrl()}${prefix}/mcp`)}
    </div>`;
  return page('Oura Ring connector', body);
}

export function connect() {
  const { clientId, clientSecret } = cfg();
  if (!clientId || !clientSecret || !storageReady()) {
    return messagePage('Not ready yet', '<p>Save OURA_CLIENT_ID and OURA_CLIENT_SECRET in Vercel (and make sure storage is connected), then redeploy.</p>');
  }
  const key = oauthKey();
  const nonce = randomToken(18);
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri(),
    scope: scopes(),
    state: signState({ t: Date.now(), n: nonce, s: 'oura' }, key),
    code_challenge: pkceChallenge(pkceVerifier(key, nonce)),
    code_challenge_method: 'S256',
  });
  return redirect(`${AUTH_URL}?${params}`, { 'set-cookie': setCookie(COOKIE, nonce, 900) });
}

export async function callback(request, url) {
  const clear = { 'set-cookie': setCookie(COOKIE, '', 0) };
  const { clientId, clientSecret } = cfg();
  if (!clientId || !clientSecret || !storageReady()) return messagePage('Not ready yet', '<p>The Oura connector is not fully configured.</p>');
  const error = url.searchParams.get('error');
  if (error) {
    return messagePage('Oura sign-in was not completed', error === 'access_denied'
      ? '<p>The sign-in was cancelled or access was not allowed. Go back to the setup page and try again.</p>'
      : `<p>Oura returned an error: <code class="inline">${esc(error)}</code>. Check that the scopes allowed in your Oura application match the setup page, then try again.</p>`, { headers: clear });
  }
  const key = oauthKey();
  const state = verifyState(url.searchParams.get('state'), key);
  const nonce = readCookie(request, COOKIE);
  if (!state || state.s !== 'oura' || !nonce || !safeEqual(nonce, state.n)) {
    return messagePage('Link expired', '<p>This sign-in link expired or was opened in a different browser. Go back to the setup page and click <b>Connect Oura account</b> again (in the same browser).</p>', { headers: clear });
  }
  const code = url.searchParams.get('code');
  if (!code) return messagePage('Missing code', '<p>Oura did not return an authorization code. Please try again.</p>', { headers: clear });
  let tok;
  try {
    tok = await tokenRequest({
      grant_type: 'authorization_code', code, redirect_uri: redirectUri(), code_verifier: pkceVerifier(key, state.n),
    });
  } catch (err) {
    logError('oura-callback', err);
    return messagePage('Oura refused the sign-in', `<p>${esc(err.message)}. Go back to the setup page and try again.</p>`, { headers: clear });
  }
  const record = toRecord(tok);
  try {
    await saveRecord(record);
  } catch (err) {
    logError('oura-callback-store', err);
    return messagePage('Could not save the Oura sign-in', '<p>Saving to Vercel Blob storage failed. Make sure the Blob store is connected to this project, redeploy, and try again.</p>', { status: 500, headers: clear });
  }
  memory = record;
  let check;
  try {
    const info = await ouraGet('/personal_info');
    check = `&#10003; Test passed: connected to the Oura account ${esc(info?.email || info?.id || '')}.`;
  } catch (err) {
    check = `Connected, but the test call failed: ${esc(err.message)}`;
  }
  const body = `
    <h1>&#10003; Oura account connected</h1>
    <div class="card success"><p>${check}</p>
    <p>Your Oura sign-in is stored encrypted in your private Vercel storage and renews itself automatically. There is nothing to copy.</p>
    <p>You can close this tab. Next, add your connector URL in Claude: <b>Settings &rarr; Connectors &rarr; Add custom connector</b>.</p></div>`;
  return page('Oura account connected', body, { headers: clear });
}
