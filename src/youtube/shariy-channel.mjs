export const SHARIY_CHANNEL_ID = 'UCVPYbobPRzz0SjinWekjUBw';
export const YOUTUBE_PAGE_SIZE = 20;
const API = 'https://www.googleapis.com/youtube/v3';

function count(value) {
  if (value === undefined || value === null || !/^\d+$/.test(String(value))) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}

function durationSeconds(value) {
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(value ?? '');
  if (!match) return null;
  return Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0);
}

async function youtube(path, params, apiKey) {
  const url = new URL(`${API}/${path}`);
  for (const [key, value] of Object.entries({ ...params, key: apiKey })) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(12_000), next: { revalidate: 300 } });
  if (!response.ok) {
    const error = new Error('YOUTUBE_UPSTREAM_ERROR');
    error.status = response.status;
    try { error.reason = (await response.json())?.error?.errors?.[0]?.reason; } catch { /* Ignore provider body. */ }
    throw error;
  }
  return response.json();
}

export async function listShariyChannelVideos(pageToken) {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) throw Error('YOUTUBE_API_NOT_CONFIGURED');
  if (pageToken !== undefined && (typeof pageToken !== 'string' || pageToken.length > 1024
      || !/^[A-Za-z0-9_./=-]+$/.test(pageToken))) throw Error('INVALID_PAGE_TOKEN');

  const channel = await youtube('channels', { part: 'contentDetails,snippet', id: SHARIY_CHANNEL_ID }, apiKey);
  const channelItem = channel.items?.find(item => item.id === SHARIY_CHANNEL_ID);
  if (!channelItem) throw Error('YOUTUBE_CHANNEL_NOT_FOUND');
  const uploadsPlaylistId = channelItem.contentDetails?.relatedPlaylists?.uploads;
  if (!uploadsPlaylistId) throw Error('YOUTUBE_CHANNEL_NOT_FOUND');

  const playlist = await youtube('playlistItems', {
    part: 'snippet,contentDetails', playlistId: uploadsPlaylistId, maxResults: YOUTUBE_PAGE_SIZE, pageToken,
  }, apiKey);
  const entries = (playlist.items ?? []).map(item => ({
    videoId: item.contentDetails?.videoId ?? item.snippet?.resourceId?.videoId,
    publishedAt: item.contentDetails?.videoPublishedAt ?? item.snippet?.publishedAt ?? null,
  })).filter(item => typeof item.videoId === 'string' && /^[A-Za-z0-9_-]{11}$/.test(item.videoId));

  const details = entries.length ? await youtube('videos', {
    part: 'snippet,contentDetails,statistics,status', id: entries.map(item => item.videoId).join(','),
  }, apiKey) : { items: [] };
  const byId = new Map((details.items ?? []).map(item => [item.id, item]));
  const videos = entries.map(entry => {
    const item = byId.get(entry.videoId);
    const snippet = item?.snippet ?? {};
    const statistics = item?.statistics ?? {};
    const thumbnails = snippet.thumbnails ?? {};
    return {
      videoId: entry.videoId,
      url: `https://www.youtube.com/watch?v=${entry.videoId}`,
      title: snippet.title ?? 'Відео недоступне',
      description: snippet.description ?? '',
      publishedAt: snippet.publishedAt ?? entry.publishedAt,
      thumbnailUrl: thumbnails.maxres?.url ?? thumbnails.high?.url ?? thumbnails.medium?.url ?? thumbnails.default?.url ?? null,
      durationSeconds: durationSeconds(item?.contentDetails?.duration),
      viewCount: count(statistics.viewCount),
      likeCount: count(statistics.likeCount),
      commentCount: count(statistics.commentCount),
      tags: Array.isArray(snippet.tags) ? snippet.tags.slice(0, 50) : [],
      categoryId: snippet.categoryId ?? null,
      defaultLanguage: snippet.defaultLanguage ?? snippet.defaultAudioLanguage ?? null,
      privacyStatus: item?.status?.privacyStatus ?? null,
    };
  });

  // Newest uploads first by default; the UI can sort the current page by views or likes.
  videos.sort((a, b) => String(b.publishedAt ?? '').localeCompare(String(a.publishedAt ?? ''))
    || a.videoId.localeCompare(b.videoId));
  return {
    channel: { id: SHARIY_CHANNEL_ID, title: channelItem.snippet?.title ?? 'Анатолий Шарий' },
    videos,
    nextPageToken: playlist.nextPageToken ?? null,
    previousPageToken: playlist.prevPageToken ?? null,
    totalResults: Number.isSafeInteger(playlist.pageInfo?.totalResults) ? playlist.pageInfo.totalResults : null,
    pageSize: YOUTUBE_PAGE_SIZE,
  };
}
