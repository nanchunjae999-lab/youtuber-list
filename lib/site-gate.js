'use strict';
// 사이트 문지기 — 대시보드에서 승인한 기기 + 대시보드가 만든 초대 링크만 이 사이트를 본다
// (2026-11-10 사용자 "로그인해야 하는 건 로그인 기능 삭제 - 대시보드 허용 기기면 접근 되게끔" + 답 "허용 기기+초대만 열리게").
// ported from ~/projects/tool box/celeb-buzz-site/worker/gate.js @ 2026-11-10 (같은 통행증·같은 공개키, 버튼만 /go/yt-email)
//   통행증(rd_pass) = 대시보드 /go/yt-email(기기) 또는 초대 링크(/auth/enter?p=)가 Ed25519 로 서명한 토큰 {k:'pass', d, t, s}.
//   요청마다 6시간 안의 rd_ok 가 없으면 대시보드 /rp/check 에 묻는다:
//   200 → rd_ok 심고 통과 · 403/400 → 쿠키 지우고 막음 · 연결 실패·시간 초과·5xx → 기기는 통과(fail-open), 초대(d='i…')는 503(fail-closed).
//   통행증 s 가 이 사이트(yt-email)가 아니면 거절, s 없는 옛 기기 통행증만 통과.
const { createPublicKey, verify } = require('node:crypto');

const DEFAULT_DASHBOARD_URL = 'https://my-mac.tail9edefe.ts.net';
// 대시보드 <dataDir>/reels-pass.key 의 공개키(원시 32바이트 base64url) — 비밀 아님.
const DEFAULT_PUBLIC_KEY = 'KZ-9obG6TledjBXRK2ijSLMgoBcsPqN9aO2g5kp9gGQ';
const SITE_ID = 'yt-email';
const GO_PATH = '/go/yt-email';
const PASS_COOKIE = 'rd_pass';
const OK_COOKIE = 'rd_ok';
const PASS_MAX_AGE = 400 * 24 * 60 * 60;
const OK_MAX_AGE = 6 * 60 * 60;
const OK_TTL_MS = OK_MAX_AGE * 1000;
const FUTURE_SKEW_MS = 5 * 60 * 1000;
const TOKEN_RE = /^v1\.([A-Za-z0-9_-]{1,400})\.([A-Za-z0-9_-]{86})$/;
const DEVICE_RE = /^(owner|[0-9a-f]{16}|i[0-9a-f]{16})$/;
const isInvite = (d) => d.startsWith('i');

const keyCache = new Map();
function publicKeyOf(raw) {
  if (!keyCache.has(raw)) {
    let key = null;
    if (typeof raw === 'string' && /^[A-Za-z0-9_-]{43}$/.test(raw)) {
      try { key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw }, format: 'jwk' }); } catch { key = null; }
    }
    keyCache.set(raw, key);
  }
  return keyCache.get(raw);
}

function readToken(raw, token, kind) {
  const match = typeof token === 'string' ? TOKEN_RE.exec(token) : null;
  const key = match ? publicKeyOf(raw) : null;
  if (!match || !key) return null;
  if (!verify(null, Buffer.from(`v1.${match[1]}`), key, Buffer.from(match[2], 'base64url'))) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8')); } catch { return null; }
  if (!payload || payload.k !== kind || typeof payload.d !== 'string' || !DEVICE_RE.test(payload.d) || typeof payload.t !== 'number') return null;
  if (payload.s !== undefined && payload.s !== SITE_ID) return null;
  if (isInvite(payload.d) && payload.s === undefined) return null;
  return payload;
}

function cookies(req) {
  const jar = new Map();
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0) jar.set(part.slice(0, at).trim(), part.slice(at + 1).trim());
  }
  return jar;
}

const cookie = (name, value, maxAge) => `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
const CLEAR = [cookie(PASS_COOKIE, '', 0), cookie(OK_COOKIE, '', 0)];
const isDocument = (req) => req.headers['sec-fetch-mode'] === 'navigate' || String(req.headers.accept ?? '').includes('text/html');
const escapeHtml = (text) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(title, body, button) {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>유튜브 컨택 리스트 수집기</title></head>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f7f9;color:#172238;font-family:system-ui,-apple-system,'Apple SD Gothic Neo',sans-serif">
<main style="max-width:360px;padding:24px;text-align:center"><p style="font-size:13px;font-weight:700;color:#ff0033;margin:0 0 8px">유튜브 컨택 리스트 수집기</p>
<h1 style="font-size:18px;margin:0 0 8px">${title}</h1><p style="font-size:14px;color:#5f6673;margin:0 0 20px">${body}</p>${button}</main></body></html>`;
}

function send(req, res, status, { clear = false, json, title, body, button = '' }) {
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  if (clear) res.setHeader('set-cookie', CLEAR);
  if (status === 503) res.setHeader('retry-after', '60');
  if (!isDocument(req)) return res.status(status).type('application/json').send(JSON.stringify({ error: json }));
  res.setHeader('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'");
  return res.status(status).type('text/html').send(page(title, body, button));
}

function denied(req, res, cfg, clear) {
  const go = escapeHtml(`${cfg.dashboardUrl}${GO_PATH}`);
  return send(req, res, 401, { clear, json: '대시보드에서 승인한 기기나 초대 링크로만 볼 수 있어요',
    title: '대시보드에서 승인한 기기만 볼 수 있어요', body: '승인된 기기라면 대시보드를 거쳐 다시 열어 주세요. 초대받았다면 받은 링크로 다시 열어 주세요.',
    button: `<a href="${go}" style="display:inline-block;padding:10px 16px;border-radius:10px;background:#172238;color:#fff;text-decoration:none;font-size:14px;font-weight:700">대시보드에서 열기</a>` });
}

const unavailable = (req, res) => send(req, res, 503, { json: '지금 초대 링크를 확인할 수 없어요. 잠시 뒤 다시 열어 주세요.',
  title: '지금 초대 링크를 확인할 수 없어요', body: '잠시 뒤 다시 열어 주세요.' });

async function askDashboard(pass, d, cfg, deps) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), cfg.checkTimeoutMs ?? 2500);
  try {
    const response = await deps.fetch(`${cfg.dashboardUrl}/rp/check?p=${encodeURIComponent(pass)}`,
      { signal: controller.signal, headers: { accept: 'application/json' } });
    if (response.status === 403 || response.status === 400) return { state: 'revoked' };
    if (response.status !== 200) return { state: 'unknown' };
    const body = await response.json().catch(() => null);
    const ok = typeof body?.ok === 'string' ? readToken(cfg.publicKey, body.ok, 'ok') : null;
    if (!ok) return { state: 'unknown' };
    return { state: 'ok', okToken: ok.d === d ? body.ok : null };
  } catch {
    return { state: 'unknown' };
  } finally {
    clearTimeout(timer);
  }
}

/** Express middleware. cfg = {publicKey, dashboardUrl, checkTimeoutMs?}, deps = {fetch, now}. */
function createGate(cfg, deps = { fetch: (url, init) => fetch(url, init), now: Date.now }) {
  const config = { ...cfg, dashboardUrl: String(cfg.dashboardUrl).replace(/\/$/, '') };
  return async function siteGate(req, res, next) {
    try {
      if (req.path === '/auth/enter') {
        const pass = typeof req.query.p === 'string' ? req.query.p : '';
        if (!readToken(config.publicKey, pass, 'pass')) return denied(req, res, config, true);
        res.setHeader('cache-control', 'no-store');
        res.setHeader('set-cookie', [cookie(PASS_COOKIE, pass, PASS_MAX_AGE), cookie(OK_COOKIE, '', 0)]);
        return res.redirect(303, '/');
      }
      const jar = cookies(req);
      const passToken = jar.get(PASS_COOKIE);
      const pass = readToken(config.publicKey, passToken, 'pass');
      if (!pass) return denied(req, res, config, Boolean(passToken));
      const setCookies = isDocument(req) ? [cookie(PASS_COOKIE, passToken, PASS_MAX_AGE)] : [];
      const ok = readToken(config.publicKey, jar.get(OK_COOKIE), 'ok');
      const now = deps.now();
      if (!(ok && ok.d === pass.d && now - ok.t <= OK_TTL_MS && ok.t - now <= FUTURE_SKEW_MS)) {
        let outcome = await askDashboard(passToken, pass.d, config, deps);
        // 초대는 fail-closed 라 대시보드 답 한 번 놓친 것으로 503 을 보이지 않게 한 번만 더 묻는다(2026-11-10 배포 뒤 실측).
        if (outcome.state === 'unknown' && isInvite(pass.d)) outcome = await askDashboard(passToken, pass.d, config, deps);
        if (outcome.state === 'revoked') return denied(req, res, config, true);
        if (outcome.state !== 'ok' && isInvite(pass.d)) return unavailable(req, res);
        if (outcome.state === 'ok' && outcome.okToken) setCookies.push(cookie(OK_COOKIE, outcome.okToken, OK_MAX_AGE));
      }
      if (setCookies.length) res.setHeader('set-cookie', setCookies);
      res.setHeader('cache-control', 'private, no-store');
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

module.exports = { createGate, DEFAULT_DASHBOARD_URL, DEFAULT_PUBLIC_KEY, SITE_ID, GO_PATH };
