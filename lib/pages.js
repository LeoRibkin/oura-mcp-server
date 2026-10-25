// Minimal HTML pages for the private setup screens.
import crypto from 'node:crypto';
import { SECURITY_HEADERS } from './util.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const CSS = `
:root{color-scheme:light dark;--bg:#f5f6f8;--card:#fff;--fg:#1c1f24;--muted:#5d6570;--line:#e2e5e9;--ok:#1a7f37;--bad:#c62828;--accent:#3454d1;--code:#f0f2f4;--warn:#b7791f}
@media (prefers-color-scheme:dark){:root{--bg:#111316;--card:#1a1d21;--fg:#e8eaed;--muted:#a1a8b1;--line:#2c3036;--ok:#4cc26b;--bad:#ff6b6b;--accent:#8aa0ff;--code:#23272c;--warn:#e0a83a}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:720px;margin:0 auto;padding:32px 16px 64px}
h1{font-size:1.55rem;margin:0 0 4px}
h2{font-size:1.1rem;margin:0 0 10px}
.lead{color:var(--muted);margin:0 0 18px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px 20px;margin:14px 0}
.card.success{border-left:5px solid var(--ok)}
.card.error{border-left:5px solid var(--bad)}
.card.warn{border-left:5px solid var(--warn)}
ul.status{list-style:none;margin:0;padding:0}
ul.status li{display:flex;gap:12px;padding:10px 0;border-bottom:1px solid var(--line)}
ul.status li:last-child{border-bottom:0}
.dot{flex:0 0 26px;height:26px;border-radius:50%;display:grid;place-items:center;font-weight:700;color:#fff;background:var(--muted)}
li.ok .dot{background:var(--ok)}
li.bad .dot{background:var(--bad)}
.detail{color:var(--muted);font-size:.93rem;overflow-wrap:anywhere}
.copy{display:flex;gap:8px;align-items:stretch;margin:6px 0 14px}
.copy code,.copy textarea{flex:1;min-width:0;background:var(--code);border:1px solid var(--line);border-radius:8px;padding:10px 12px;font:13px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--fg);overflow-wrap:anywhere;word-break:break-all;resize:none}
.btn,.copy button{appearance:none;border:0;border-radius:8px;padding:10px 16px;font:600 15px system-ui,sans-serif;background:var(--accent);color:#fff;cursor:pointer;text-decoration:none;display:inline-block;white-space:nowrap}
.btn.disabled{background:var(--line);color:var(--muted);cursor:not-allowed}
label{display:block;font-weight:600;margin-top:6px}
ol{padding-left:22px}ol li{margin:6px 0}
.muted{color:var(--muted)}
code.inline{background:var(--code);padding:1px 6px;border-radius:5px;font-size:.92em}
`;

const JS = `document.addEventListener('click',async(e)=>{const b=e.target.closest('[data-copy]');if(!b)return;const el=document.getElementById(b.dataset.copy);const v=el.value!==undefined?el.value:el.textContent;try{await navigator.clipboard.writeText(v)}catch{el.select?el.select():0;document.execCommand('copy')}const o=b.textContent;b.textContent='Copied \\u2713';setTimeout(()=>{b.textContent=o},1800)});`;

export function page(title, body, { status = 200, headers = {} } = {}) {
  const nonce = crypto.randomBytes(16).toString('base64');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">`
    + `<title>${esc(title)}</title><style>${CSS}</style></head><body><main>${body}</main>`
    + `<script nonce="${nonce}">${JS}</script></body></html>`;
  return new Response(html, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      ...SECURITY_HEADERS,
      ...headers,
    },
  });
}

// rows: [state ('ok' | 'bad' | 'todo'), labelHtml, detailHtml?]
export const statusList = (rows) => `<ul class="status">${rows.map(([state, label, detail]) =>
  `<li class="${state}"><span class="dot">${state === 'ok' ? '&#10003;' : state === 'bad' ? '&#10007;' : '&bull;'}</span>`
  + `<div><strong>${label}</strong>${detail ? `<div class="detail">${detail}</div>` : ''}</div></li>`).join('')}</ul>`;

export function copyBox(value, { multiline = false } = {}) {
  const id = `v${crypto.randomBytes(4).toString('hex')}`;
  const field = multiline
    ? `<textarea id="${id}" readonly rows="4" spellcheck="false">${esc(value)}</textarea>`
    : `<code id="${id}">${esc(value)}</code>`;
  return `<div class="copy">${field}<button type="button" data-copy="${id}">Copy</button></div>`;
}

export const button = (href, label, enabled = true) => (enabled
  ? `<a class="btn" href="${esc(href)}">${esc(label)}</a>`
  : `<span class="btn disabled">${esc(label)}</span>`);

export const messagePage = (title, html, { kind = 'error', status = 400, headers } = {}) =>
  page(title, `<h1>${esc(title)}</h1><div class="card ${kind}">${html}</div>`, { status, headers });
