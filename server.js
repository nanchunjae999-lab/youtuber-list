'use strict';

const path = require('path');
const express = require('express');
const ExcelJS = require('exceljs');
const { collect } = require('./lib/youtube');

const app = express();
const PORT = process.env.PORT || 3456;

app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/** 수집 실행 — NDJSON 스트리밍 (진행상황 실시간 전송) */
app.post('/api/collect', async (req, res) => {
  const { apiKeys, keyword } = req.body || {};

  if (!Array.isArray(apiKeys) || apiKeys.filter((k) => k && k.trim()).length === 0) {
    return res.status(400).json({ error: 'API 키를 1개 이상 입력해주세요.' });
  }
  if (!keyword || !keyword.trim()) {
    return res.status(400).json({ error: '검색 키워드는 필수입니다.' });
  }

  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  const send = (obj) => res.write(JSON.stringify(obj) + '\n');

  try {
    const result = await collect(
      {
        ...req.body,
        apiKeys: apiKeys.map((k) => k.trim()).filter(Boolean),
        keyword: keyword.trim(),
      },
      send
    );
    send({ type: 'done', ...result });
  } catch (err) {
    send({ type: 'error', message: err.message });
  }
  res.end();
});

/** 엑셀 다운로드 */
app.post('/api/export', async (req, res) => {
  const rows = req.body?.rows;
  if (!Array.isArray(rows) || rows.length === 0) {
    return res.status(400).json({ error: '내보낼 데이터가 없습니다.' });
  }

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('채널 리스트');
  ws.columns = [
    { header: '채널명', key: 'title', width: 28 },
    { header: '채널 URL', key: 'url', width: 42 },
    { header: '이메일', key: 'emails', width: 30 },
    { header: '구독자수', key: 'subscriberCount', width: 12 },
    { header: '평균 조회수', key: 'avgViews', width: 12 },
    { header: '구독자 대비 조회수(%)', key: 'viewsToSubs', width: 18 },
    { header: '참여율(%)', key: 'engagementRate', width: 10 },
    { header: '평균 좋아요', key: 'avgLikes', width: 11 },
    { header: '평균 댓글', key: 'avgComments', width: 10 },
    { header: '총 영상수', key: 'videoCount', width: 10 },
    { header: '국가', key: 'country', width: 7 },
    { header: '채널 개설일', key: 'publishedAt', width: 12 },
    { header: '채널 설명', key: 'description', width: 60 },
  ];
  for (const r of rows) {
    ws.addRow({ ...r, emails: (r.emails || []).join(', ') });
  }
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFEEEEEE' },
  };
  ws.autoFilter = { from: 'A1', to: 'M1' };
  ws.views = [{ state: 'frozen', ySplit: 1 }];

  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  );
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="youtube_contacts_${date}.xlsx"`
  );
  await wb.xlsx.write(res);
  res.end();
});

app.listen(PORT, () => {
  console.log(`✅ 유튜브 컨택 리스트 수집기 실행 중: http://localhost:${PORT}`);
});
