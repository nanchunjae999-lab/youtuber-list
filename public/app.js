'use strict';

const $ = (id) => document.getElementById(id);
let collectedRows = [];

// ── localStorage 복원 ─────────────────────────────────────────
$('api-keys').value = localStorage.getItem('yt_api_keys') || '';
$('keyword').value = localStorage.getItem('yt_keyword') || '';
$('api-keys').addEventListener('input', (e) => localStorage.setItem('yt_api_keys', e.target.value));
$('keyword').addEventListener('input', (e) => localStorage.setItem('yt_keyword', e.target.value));

// ── 테스트키 ─────────────────────────────────────────────────
fetch('/api/test-key-status')
  .then((r) => r.json())
  .then(({ available }) => {
    if (!available) return;
    $('test-key-wrap').classList.remove('hidden');
    $('use-test-key').checked = localStorage.getItem('yt_use_test_key') === '1';
    applyTestKeyState();
  })
  .catch(() => {});

$('use-test-key').addEventListener('change', () => {
  localStorage.setItem('yt_use_test_key', $('use-test-key').checked ? '1' : '0');
  applyTestKeyState();
});

function applyTestKeyState() {
  const on = $('use-test-key').checked;
  $('api-keys').disabled = on;
  $('api-keys').placeholder = on ? '테스트키를 사용합니다' : 'AIzaSy... (한 줄에 키 1개)';
}

// ── UI 토글 ──────────────────────────────────────────────────
$('btn-key-help').addEventListener('click', () => $('key-help').classList.toggle('hidden'));
[
  ['use-subs', 'body-subs'],
  ['use-ratio', 'body-ratio'],
  ['use-engagement', 'body-engagement'],
  ['use-detail', 'body-detail'],
].forEach(([cb, body]) => {
  $(cb).addEventListener('change', () => $(body).classList.toggle('hidden', !$(cb).checked));
});

// ── 수집 실행 ─────────────────────────────────────────────────
$('btn-collect').addEventListener('click', startCollect);

function log(msg, cls = '') {
  const div = document.createElement('div');
  if (cls) div.className = cls;
  div.textContent = `[${new Date().toLocaleTimeString('ko-KR', { hour12: false })}] ${msg}`;
  $('log').appendChild(div);
  $('log').scrollTop = $('log').scrollHeight;
}

function buildPayload() {
  const val = (id) => $(id).value.trim();
  const payload = {
    useTestKey: $('use-test-key').checked,
    apiKeys: val('api-keys').split('\n').map((k) => k.trim()).filter(Boolean),
    keyword: val('keyword'),
    searchPages: val('search-pages'),
    recentVideos: val('recent-videos'),
  };
  if ($('use-subs').checked) {
    if (val('sub-min')) payload.subMin = val('sub-min');
    if (val('sub-max')) payload.subMax = val('sub-max');
  }
  if ($('use-ratio').checked && val('ratio-min')) payload.viewsToSubsMin = val('ratio-min');
  if ($('use-engagement').checked && val('engagement-min')) payload.engagementMin = val('engagement-min');
  if ($('use-detail').checked) {
    if (val('comments-min')) payload.avgCommentsMin = val('comments-min');
    if (val('likes-min')) payload.avgLikesMin = val('likes-min');
  }
  return payload;
}

async function startCollect() {
  const payload = buildPayload();
  if (!payload.useTestKey && payload.apiKeys.length === 0) return alert('API 키를 1개 이상 입력해주세요.');
  if (!payload.keyword) return alert('검색 키워드를 입력해주세요.');

  $('btn-collect').disabled = true;
  $('btn-collect').textContent = '수집 중...';
  $('progress-card').classList.remove('hidden');
  $('result-card').classList.add('hidden');
  $('log').innerHTML = '';
  $('quota-used').textContent = '';
  log(payload.useTestKey ? '수집 시작 — 테스트키 사용' : `수집 시작 — API 키 ${payload.apiKeys.length}개 사용`);

  try {
    const res = await fetch('/api/collect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `서버 오류 (HTTP ${res.status})`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        handleEvent(JSON.parse(line));
      }
    }
  } catch (err) {
    log(`오류: ${err.message}`, 'err');
  } finally {
    $('btn-collect').disabled = false;
    $('btn-collect').textContent = '수집 시작';
  }
}

function handleEvent(ev) {
  if (ev.type === 'progress') {
    log(ev.message);
    if (ev.quotaUsed !== undefined) $('quota-used').textContent = `쿼터 사용: ${ev.quotaUsed.toLocaleString()}유닛`;
  } else if (ev.type === 'done') {
    collectedRows = ev.channels;
    log(`완료! 후보 ${ev.candidates}개 중 조건 통과 ${ev.channels.length}개 채널 (쿼터 ${ev.quotaUsed.toLocaleString()}유닛 사용)`, 'ok');
    $('quota-used').textContent = `쿼터 사용: ${ev.quotaUsed.toLocaleString()}유닛`;
    renderTable();
    $('result-card').classList.remove('hidden');
  } else if (ev.type === 'error') {
    log(`오류: ${ev.message}`, 'err');
  }
}

// ── 결과 렌더링 ───────────────────────────────────────────────
$('only-email').addEventListener('change', renderTable);

function visibleRows() {
  return $('only-email').checked
    ? collectedRows.filter((r) => r.emails && r.emails.length > 0)
    : collectedRows;
}

function fmt(n) {
  return n === null || n === undefined ? '-' : n.toLocaleString('ko-KR');
}

function renderTable() {
  const rows = visibleRows();
  const emailCount = collectedRows.filter((r) => r.emails?.length).length;
  $('result-count').textContent = `${rows.length}개 채널 (이메일 보유 ${emailCount}개)`;

  const tbody = $('result-table').querySelector('tbody');
  tbody.innerHTML = '';
  rows.forEach((r, i) => {
    const tr = document.createElement('tr');

    const tdIdx = document.createElement('td');
    tdIdx.textContent = i + 1;

    const tdTitle = document.createElement('td');
    const a = document.createElement('a');
    a.href = r.url;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = r.title;
    tdTitle.appendChild(a);

    const cells = [
      fmt(r.subscriberCount),
      fmt(r.avgViews),
      r.viewsToSubs === null ? '-' : r.viewsToSubs + '%',
      r.engagementRate === null ? '-' : r.engagementRate + '%',
      fmt(r.avgLikes),
      fmt(r.avgComments),
    ];

    tr.appendChild(tdIdx);
    tr.appendChild(tdTitle);
    for (const c of cells) {
      const td = document.createElement('td');
      td.textContent = c;
      tr.appendChild(td);
    }

    const tdEmail = document.createElement('td');
    if (r.emails?.length) {
      tdEmail.className = 'email-cell';
      tdEmail.textContent = r.emails.join(', ');
    } else {
      tdEmail.className = 'email-none';
      tdEmail.textContent = '없음';
    }
    tr.appendChild(tdEmail);
    tbody.appendChild(tr);
  });
}

// ── 엑셀 다운로드 ─────────────────────────────────────────────
$('btn-export').addEventListener('click', async () => {
  const rows = visibleRows();
  if (rows.length === 0) return alert('내보낼 데이터가 없습니다.');

  const res = await fetch('/api/export', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rows }),
  });
  if (!res.ok) return alert('엑셀 생성에 실패했습니다.');

  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `youtube_contacts_${new Date().toISOString().slice(0, 10)}.xlsx`;
  a.click();
  URL.revokeObjectURL(url);
});
