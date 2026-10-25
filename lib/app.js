// Request router. Every private route lives under an unguessable path secret.
import { serveMcp } from './mcp.js';
import * as oura from './oura.js';
import { env, safeEqual, notFound, text, logError } from './util.js';
import { page } from './pages.js';

const SECRET_VAR = 'OURA_PATH_SECRET';
const USABLE_SECRET = /^[A-Za-z0-9_-]{16,}$/;

// Vercel rewrites every path to this one function; recover the original path.
function resolvePath(url) {
  let path = url.pathname;
  if (/^\/api(\/index(\.js)?)?\/?$/.test(path) && url.searchParams.has('__p')) {
    path = `/${url.searchParams.get('__p').replace(/^\/+/, '')}`;
  }
  return path.replace(/\/+$/, '') || '/';
}

const INFO = {
  privacy: ['Privacy policy', 'This is a private, single-user integration that lets Claude read Oura Ring data. It is run by '
    + 'the person who deploys this instance, for their own use, and it only accesses that person\'s own Oura data when they ask '
    + 'for it. Data is not sold, shared or used for advertising. Sign-in tokens are stored encrypted in that person\'s own '
    + 'Vercel account and are never logged.'],
  terms: ['Terms of service', 'This integration is for the personal use of the person who deploys this instance. It is '
    + 'provided as-is, without warranty of any kind. No other users are permitted.'],
};

// The home page stays a bare "Private service." once configured. While the path
// secret is missing or unusable it says so (without ever revealing a secret).
function home() {
  const secret = env(SECRET_VAR);
  if (USABLE_SECRET.test(secret)) return text('Private service.');
  const problem = secret
    ? 'must be at least 16 characters and use only letters, digits, "-" and "_"'
    : 'is not set';
  return text(`Setup incomplete: the ${SECRET_VAR} environment variable ${problem}. Set it in Vercel `
    + '(Settings > Environment Variables), redeploy, then open /oura/<your secret>/setup. See the README for details.');
}

export async function handle(request) {
  try {
    const url = new URL(request.url);
    const path = resolvePath(url);

    if (path === '/') return home();
    if (path === '/privacy' || path === '/terms') {
      const [title, body] = INFO[path.slice(1)];
      return page(title, `<h1>${title}</h1><div class="card"><p>${body}</p></div>`);
    }
    if (path === oura.OURA_CALLBACK_PATH && request.method === 'GET') return await oura.callback(request, url);

    const m = /^\/oura\/([^/]+)\/(mcp|setup|connect)$/.exec(path);
    if (m) {
      const [, secret, action] = m;
      const expected = env(SECRET_VAR);
      if (expected.length < 16 || !safeEqual(secret, expected)) return notFound();
      if (action === 'mcp') return await serveMcp(request, oura.createServer);
      if (request.method !== 'GET') return text('Method not allowed', 405, { allow: 'GET' });
      if (action === 'setup') return await oura.setupPage(`/oura/${secret}`);
      return oura.connect(request);
    }
    return notFound();
  } catch (err) {
    logError('handler', err);
    return text('Internal error', 500);
  }
}
