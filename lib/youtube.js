'use strict';

const API_BASE = 'https://www.googleapis.com/youtube/v3';
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

const QUOTA_COST = { search: 100, channels: 1, playlistItems: 1, videos: 1 };

class QuotaExhaustedError extends Error {
  constructor() {
    super('모든 API 키의 일일 쿼터가 소진되었습니다.');
    this.name = 'QuotaExhaustedError';
  }
}

/** 다중 API 키 로테이션 클라이언트 */
class YouTubeClient {
  constructor(apiKeys) {
    this.keys = apiKeys.map((key) => ({ key, dead: false, reason: null }));
    this.idx = 0;
    this.quotaUsed = 0;
  }

  get aliveCount() {
    return this.keys.filter((k) => !k.dead).length;
  }

  _currentKey() {
    const start = this.idx;
    for (let i = 0; i < this.keys.length; i++) {
      const j = (start + i) % this.keys.length;
      if (!this.keys[j].dead) {
        this.idx = j;
        return this.keys[j];
      }
    }
    throw new QuotaExhaustedError();
  }

  async call(endpoint, params) {
    for (;;) {
      const entry = this._currentKey();
      const qs = new URLSearchParams({ ...params, key: entry.key });
      const res = await fetch(`${API_BASE}/${endpoint}?${qs}`);
      const body = await res.json().catch(() => ({}));

      if (res.ok) {
        this.quotaUsed += QUOTA_COST[endpoint] || 1;
        return body;
      }

      const reason = body?.error?.errors?.[0]?.reason || '';
      const message = body?.error?.message || `HTTP ${res.status}`;

      if (['quotaExceeded', 'dailyLimitExceeded', 'rateLimitExceeded'].includes(reason)) {
        entry.dead = true;
        entry.reason = 'quota';
        continue; // 다음 키로 로테이션
      }
      if (res.status === 400 || res.status === 403) {
        // keyInvalid, API 미활성화 등 → 해당 키 폐기 후 다음 키 시도
        entry.dead = true;
        entry.reason = message;
        if (this.aliveCount === 0) {
          throw new Error(`사용 가능한 API 키가 없습니다. 마지막 오류: ${message}`);
        }
        continue;
      }
      throw new Error(`YouTube API 오류 (${endpoint}): ${message}`);
    }
  }
}

function toInt(v) {
  return v === undefined || v === null || v === '' ? null : parseInt(v, 10);
}

function extractEmails(text) {
  const found = (text || '').match(EMAIL_RE) || [];
  return [...new Set(found.map((e) => e.toLowerCase()))];
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * 수집 파이프라인
 * options: {
 *   apiKeys: string[], keyword: string, searchPages: number, recentVideos: number,
 *   subMin?: number, subMax?: number,          // 2. 구독자수 (선택)
 *   viewsToSubsMin?: number,                   // 3. 구독자 대비 조회수 % (선택)
 *   engagementMin?: number,                    // 4-1. 통합 참여율 % (선택)
 *   avgCommentsMin?: number, avgLikesMin?: number, // 4-2. 세부 설정 (선택)
 * }
 * onProgress: (event) => void
 */
async function collect(options, onProgress) {
  const client = new YouTubeClient(options.apiKeys);
  const emit = (message, extra = {}) =>
    onProgress({ type: 'progress', message, quotaUsed: client.quotaUsed, ...extra });

  const searchPages = Math.min(Math.max(toInt(options.searchPages) || 3, 1), 10);
  const recentVideos = Math.min(Math.max(toInt(options.recentVideos) || 10, 3), 20);

  // ── 1단계: 키워드 검색으로 채널 후보 수집 ──────────────────────
  emit(`"${options.keyword}" 영상 검색 시작 (최대 ${searchPages}페이지)`);
  const channelIds = new Set();
  let pageToken = '';
  for (let page = 1; page <= searchPages; page++) {
    const params = {
      part: 'snippet',
      type: 'video',
      q: options.keyword,
      maxResults: '50',
      relevanceLanguage: 'ko',
    };
    if (pageToken) params.pageToken = pageToken;
    const data = await client.call('search', params);
    for (const item of data.items || []) {
      if (item.snippet?.channelId) channelIds.add(item.snippet.channelId);
    }
    emit(`검색 ${page}/${searchPages}페이지 완료 — 채널 후보 ${channelIds.size}개`);
    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }

  if (channelIds.size === 0) {
    return { channels: [], quotaUsed: client.quotaUsed, candidates: 0 };
  }

  // ── 2단계: 채널 정보 조회 + 구독자수 필터 ──────────────────────
  emit(`채널 정보 조회 중 (${channelIds.size}개)`);
  const subMin = toInt(options.subMin);
  const subMax = toInt(options.subMax);
  const channels = [];

  for (const ids of chunk([...channelIds], 50)) {
    const data = await client.call('channels', {
      part: 'snippet,statistics,contentDetails',
      id: ids.join(','),
      maxResults: '50',
    });
    for (const ch of data.items || []) {
      const stats = ch.statistics || {};
      const hidden = stats.hiddenSubscriberCount === true;
      const subs = hidden ? null : toInt(stats.subscriberCount);

      if (subMin !== null || subMax !== null) {
        if (subs === null) continue; // 구독자수 숨김 채널은 필터 사용 시 제외
        if (subMin !== null && subs < subMin) continue;
        if (subMax !== null && subs > subMax) continue;
      }

      channels.push({
        channelId: ch.id,
        title: ch.snippet?.title || '',
        description: ch.snippet?.description || '',
        country: ch.snippet?.country || '',
        publishedAt: (ch.snippet?.publishedAt || '').slice(0, 10),
        url: `https://www.youtube.com/channel/${ch.id}`,
        customUrl: ch.snippet?.customUrl
          ? `https://www.youtube.com/${ch.snippet.customUrl}`
          : '',
        subscriberCount: subs,
        videoCount: toInt(stats.videoCount),
        uploadsPlaylist: ch.contentDetails?.relatedPlaylists?.uploads || null,
        emails: extractEmails(ch.snippet?.description),
      });
    }
  }
  emit(`구독자수 필터 통과: ${channels.length}개 채널`);

  // ── 3단계: 채널별 최근 영상 수집 ──────────────────────────────
  const videoIdsByChannel = new Map();
  let done = 0;
  for (const ch of channels) {
    done++;
    if (!ch.uploadsPlaylist) continue;
    try {
      const data = await client.call('playlistItems', {
        part: 'contentDetails',
        playlistId: ch.uploadsPlaylist,
        maxResults: String(recentVideos),
      });
      const ids = (data.items || [])
        .map((it) => it.contentDetails?.videoId)
        .filter(Boolean);
      videoIdsByChannel.set(ch.channelId, ids);
    } catch (err) {
      if (err instanceof QuotaExhaustedError) throw err;
      videoIdsByChannel.set(ch.channelId, []); // 영상 비공개/플레이리스트 없음 등
    }
    if (done % 20 === 0 || done === channels.length) {
      emit(`최근 영상 목록 수집 ${done}/${channels.length} 채널`, {
        current: done,
        total: channels.length,
      });
    }
  }

  // ── 4단계: 영상 통계 일괄 조회 ────────────────────────────────
  const allVideoIds = [...videoIdsByChannel.values()].flat();
  emit(`영상 통계 조회 중 (${allVideoIds.length}개 영상)`);
  const videoStats = new Map();
  for (const ids of chunk(allVideoIds, 50)) {
    const data = await client.call('videos', {
      part: 'statistics',
      id: ids.join(','),
      maxResults: '50',
    });
    for (const v of data.items || []) {
      videoStats.set(v.id, {
        views: toInt(v.statistics?.viewCount),
        likes: toInt(v.statistics?.likeCount), // 좋아요 숨김이면 null
        comments: toInt(v.statistics?.commentCount), // 댓글 차단이면 null
      });
    }
  }

  // ── 5단계: 지표 계산 + 선택 필터 적용 ─────────────────────────
  const viewsToSubsMin = options.viewsToSubsMin === '' ? null : parseFloat(options.viewsToSubsMin ?? '') || null;
  const engagementMin = options.engagementMin === '' ? null : parseFloat(options.engagementMin ?? '') || null;
  const avgCommentsMin = toInt(options.avgCommentsMin);
  const avgLikesMin = toInt(options.avgLikesMin);

  const results = [];
  for (const ch of channels) {
    const ids = videoIdsByChannel.get(ch.channelId) || [];
    const vids = ids.map((id) => videoStats.get(id)).filter(Boolean);
    const withViews = vids.filter((v) => v.views !== null && v.views > 0);

    const totalViews = withViews.reduce((s, v) => s + v.views, 0);
    const totalLikes = withViews.reduce((s, v) => s + (v.likes ?? 0), 0);
    const totalComments = withViews.reduce((s, v) => s + (v.comments ?? 0), 0);
    const n = withViews.length;

    const avgViews = n ? Math.round(totalViews / n) : null;
    const avgLikes = n ? Math.round(totalLikes / n) : null;
    const avgComments = n ? Math.round(totalComments / n) : null;
    const engagementRate =
      totalViews > 0 ? ((totalLikes + totalComments) / totalViews) * 100 : null;
    const viewsToSubs =
      avgViews !== null && ch.subscriberCount
        ? (avgViews / ch.subscriberCount) * 100
        : null;

    // 3. 구독자 대비 조회수 필터 (선택)
    if (viewsToSubsMin !== null && (viewsToSubs === null || viewsToSubs < viewsToSubsMin)) continue;
    // 4-1. 통합 참여율 필터 (선택)
    if (engagementMin !== null && (engagementRate === null || engagementRate < engagementMin)) continue;
    // 4-2. 세부 설정 필터 (선택)
    if (avgCommentsMin !== null && (avgComments === null || avgComments < avgCommentsMin)) continue;
    if (avgLikesMin !== null && (avgLikes === null || avgLikes < avgLikesMin)) continue;

    results.push({
      title: ch.title,
      url: ch.customUrl || ch.url,
      subscriberCount: ch.subscriberCount,
      videoCount: ch.videoCount,
      avgViews,
      viewsToSubs: viewsToSubs !== null ? +viewsToSubs.toFixed(1) : null,
      engagementRate: engagementRate !== null ? +engagementRate.toFixed(2) : null,
      avgLikes,
      avgComments,
      emails: ch.emails,
      country: ch.country,
      publishedAt: ch.publishedAt,
      sampledVideos: n,
      description: ch.description.slice(0, 300),
    });
  }

  results.sort((a, b) => (b.subscriberCount ?? 0) - (a.subscriberCount ?? 0));
  emit(`필터링 완료: 최종 ${results.length}개 채널`);

  return { channels: results, quotaUsed: client.quotaUsed, candidates: channelIds.size };
}

module.exports = { collect, QuotaExhaustedError };
