'use strict';
// 사이트 문지기 (lib/site-gate.js) — 대시보드 허용 기기 + 초대 링크만 (2026-11-10 사용자 "로그인해야 하는 건 로그인 기능 삭제 -
// 대시보드 허용 기기면 접근 되게끔" + 답 "허용 기기+초대만 열리게"). node --test test/
//   Y1 통행증 없음: 문서 401 안내('대시보드에서 열기' /go/yt-email) · API 401 JSON · 정적 파일도 막힘
//   Y2 /auth/enter 맞는 pass → 303 + rd_pass · 위조·다른 사이트·s 없는 초대 → 401
//   Y3 기기 pass: rd_ok 없으면 /rp/check 200 → 통과 + rd_ok · 403 → 쿠키 지우고 401 · 꺼짐 → 통과(fail-open)
//   Y4 초대 pass: 200 → 통과 · 403 → 401 · 꺼짐·5xx → 503(fail-closed) · 신선한 rd_ok → 확인 없이 통과
const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');
const express = require('express');
const { generateKeyPairSync, sign } = require('node:crypto');
const { createGate } = require('../lib/site-gate');

const keys = generateKeyPairSync('ed25519');
const PUBLIC = keys.publicKey.export({ format: 'jwk' }).x;
const DASH = 'https://dash.example.ts.net';
const NOW = 1_800_000_000_000;
const DEVICE = '0123456789abcdef';
const INVITE = 'i0123456789abcdef';
const DOC = { 'sec-fetch-mode': 'navigate', accept: 'text/html' };

function token(k, d, s, t = NOW, key = keys.privateKey) {
  const body = Buffer.from(JSON.stringify(s === undefined ? { k, d, t } : { k, d, t, s })).toString('base64url');
  return `v1.${body}.${sign(null, Buffer.from(`v1.${body}`), key).toString('base64url')}`;
}
const okReply = (d, s = 'yt-email') => new Response(JSON.stringify({ ok: token('ok', d, s) }), { status: 200 });

async function start(t, reply) {
  const calls = [];
  const app = express();
  app.use(createGate({ publicKey: PUBLIC, dashboardUrl: DASH, checkTimeoutMs: 100 }, {
    now: () => NOW,
    fetch: async (url, init) => {
      calls.push(String(url));
      if (reply instanceof Error) throw reply;
      if (typeof reply === 'function') return reply();
      if (reply === 'hang') return new Promise((_r, reject) => init.signal.addEventListener('abort', () => reject(new Error('abort'))));
      return reply;
    },
  }));
  app.get('/api/test-key-status', (_req, res) => res.json({ available: false }));
  app.get('/app.js', (_req, res) => res.type('js').send('ok'));
  app.get('/', (_req, res) => res.type('html').send('<h1>유튜브 컨택 리스트 수집기</h1>'));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (path, { cookies = {}, headers = {} } = {}) => {
    const cookie = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    return fetch(`${base}${path}`, { redirect: 'manual', headers: { ...(cookie ? { cookie } : {}), ...headers } });
  };
  return { get, calls };
}

test('Y1 no pass: page 401 with the dashboard button, API 401 JSON, static files blocked', async (t) => {
  const { get, calls } = await start(t, okReply(DEVICE));
  const page = await get('/', { headers: DOC });
  assert.equal(page.status, 401);
  assert.match(await page.text(), new RegExp(`${DASH}/go/yt-email`));
  const api = await get('/api/test-key-status');
  assert.equal(api.status, 401);
  assert.match(api.headers.get('content-type'), /json/);
  assert.equal((await get('/app.js')).status, 401);
  assert.equal(calls.length, 0);
});

test('Y2 /auth/enter: a good pass → 303 + rd_pass; forged, other-site and site-less invite passes → 401', async (t) => {
  const { get } = await start(t, okReply(DEVICE));
  const good = await get(`/auth/enter?p=${encodeURIComponent(token('pass', DEVICE, 'yt-email'))}`, { headers: DOC });
  assert.equal(good.status, 303);
  assert.equal(good.headers.get('location'), '/');
  assert.ok(good.headers.getSetCookie().some((c) => c.startsWith('rd_pass=v1.') && /HttpOnly/.test(c) && /Secure/.test(c)));
  const other = generateKeyPairSync('ed25519').privateKey;
  for (const p of [token('pass', DEVICE, 'yt-email', NOW, other), token('pass', DEVICE, 'reels-desire'), token('pass', INVITE, undefined), 'garbage']) {
    assert.equal((await get(`/auth/enter?p=${encodeURIComponent(p)}`, { headers: DOC })).status, 401, p);
  }
});

test('Y3 device pass: check 200 → allowed + rd_ok · 403 → cookies cleared · dashboard down → allowed', async (t) => {
  const pass = token('pass', DEVICE, 'yt-email');
  const live = await start(t, okReply(DEVICE));
  const ok = await live.get('/', { headers: DOC, cookies: { rd_pass: pass } });
  assert.equal(ok.status, 200);
  assert.match(await ok.text(), /유튜브 컨택 리스트 수집기/);
  assert.ok(ok.headers.getSetCookie().some((c) => c.startsWith('rd_ok=v1.')));
  assert.deepEqual(live.calls, [`${DASH}/rp/check?p=${encodeURIComponent(pass)}`]);
  const gone = await (await start(t, new Response('{"error":"revoked"}', { status: 403 }))).get('/api/test-key-status', { cookies: { rd_pass: pass } });
  assert.equal(gone.status, 401);
  assert.ok(gone.headers.getSetCookie().some((c) => c.startsWith('rd_pass=;') && /Max-Age=0/.test(c)));
  assert.equal((await (await start(t, new Error('down'))).get('/api/test-key-status', { cookies: { rd_pass: pass } })).status, 200);
  assert.equal((await (await start(t, new Error('down'))).get('/', { cookies: { rd_pass: token('pass', DEVICE) } })).status, 200, 'old pass without s');
});

test('Y4 invite pass: 200 allowed · 403 refused · down/5xx/timeout → 503 · fresh rd_ok skips the check', async (t) => {
  const pass = token('pass', INVITE, 'yt-email');
  assert.equal((await (await start(t, okReply(INVITE))).get('/', { headers: DOC, cookies: { rd_pass: pass } })).status, 200);
  assert.equal((await (await start(t, new Response('x', { status: 403 }))).get('/', { headers: DOC, cookies: { rd_pass: pass } })).status, 401);
  for (const reply of [new Error('down'), new Response('x', { status: 502 }), 'hang']) {
    const res = await (await start(t, reply)).get('/', { headers: DOC, cookies: { rd_pass: pass } });
    assert.equal(res.status, 503);
    assert.equal(res.headers.getSetCookie().length, 0);
  }
  const fresh = await start(t, new Error('down'));
  assert.equal((await fresh.get('/api/test-key-status', { cookies: { rd_pass: pass, rd_ok: token('ok', INVITE, 'yt-email') } })).status, 200);
  assert.equal(fresh.calls.length, 0);
  const stale = await (await start(t, new Error('down'))).get('/', { cookies: { rd_pass: pass, rd_ok: token('ok', INVITE, 'yt-email', NOW - 7 * 3_600_000) } });
  assert.equal(stale.status, 503);
});

test('Y5 an invite check that fails once is retried; devices are asked once', async (t) => {
  const pass = token('pass', INVITE, 'yt-email');
  let n = 0;
  const flaky = await start(t, () => (n++ === 0 ? new Response('x', { status: 502 }) : okReply(INVITE)));
  assert.equal((await flaky.get('/', { headers: DOC, cookies: { rd_pass: pass } })).status, 200);
  assert.equal(flaky.calls.length, 2);
  const device = await start(t, new Error('down'));
  await device.get('/', { cookies: { rd_pass: token('pass', DEVICE, 'yt-email') } });
  assert.equal(device.calls.length, 1);
});
