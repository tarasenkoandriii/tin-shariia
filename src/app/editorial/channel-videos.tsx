'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';

type ChannelVideo = {
  videoId: string; url: string; title: string; description: string; publishedAt: string | null;
  thumbnailUrl: string | null; durationSeconds: number | null; viewCount: number | null; likeCount: number | null;
  commentCount: number | null; tags: string[]; categoryId: string | null; defaultLanguage: string | null;
};
type ChannelPage = {
  channel: { id: string; title: string }; videos: ChannelVideo[]; nextPageToken: string | null;
  previousPageToken: string | null; totalResults: number | null; pageSize: number;
};

const integer = new Intl.NumberFormat('uk-UA');
const date = (value: string | null) => value ? new Intl.DateTimeFormat('uk-UA', {
  dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Kyiv',
}).format(new Date(value)) : '—';
const duration = (seconds: number | null) => {
  if (seconds === null) return '—';
  const hours = Math.floor(seconds / 3600), minutes = Math.floor((seconds % 3600) / 60), rest = seconds % 60;
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
    : `${minutes}:${String(rest).padStart(2, '0')}`;
};

export function ChannelVideos({ data, pageToken }: { data: ChannelPage; pageToken?: string }) {
  const [sort, setSort] = useState('date');
  const sorted = useMemo(() => [...data.videos].sort((a, b) => {
    if (sort === 'views') return (b.viewCount ?? -1) - (a.viewCount ?? -1);
    if (sort === 'likes') return (b.likeCount ?? -1) - (a.likeCount ?? -1);
    return String(b.publishedAt ?? '').localeCompare(String(a.publishedAt ?? ''));
  }), [data.videos, sort]);
  const pageHref = (token: string) => '/editorial/youtube-channel?pageToken=' + encodeURIComponent(token);
  return <>
    <p>{data.channel.title} · {integer.format(data.totalResults ?? 0)} відео у каналі · по {data.pageSize} на сторінку</p>
    <label className="channel-sort">Сортувати на цій сторінці
      <select value={sort} onChange={event => setSort(event.target.value)}>
        <option value="date">За датою публікації · новіші спочатку</option>
        <option value="views">За переглядами · більше спочатку</option>
        <option value="likes">За вподобаннями · більше спочатку</option>
      </select>
    </label>
    <ol className="channel-video-list">
      {sorted.map(video => <li key={video.videoId} className="channel-video-card">
        {video.thumbnailUrl && <a href={video.url} target="_blank" rel="noreferrer">
          {/* YouTube supplies these public thumbnails for its public videos. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={video.thumbnailUrl} alt="" loading="lazy" />
        </a>}
        <div className="channel-video-content">
          <h2><a href={video.url} target="_blank" rel="noreferrer">{video.title}</a></h2>
          <p className="channel-video-stats">{date(video.publishedAt)} · {duration(video.durationSeconds)} · {video.viewCount === null ? 'немає даних' : integer.format(video.viewCount)} переглядів · {video.likeCount === null ? 'не показано' : integer.format(video.likeCount)} вподобань · {video.commentCount === null ? 'не показано' : integer.format(video.commentCount)} коментарів</p>
          <details><summary>Опис і метадані</summary>
            <p className="workflow-text">{video.description}</p>
            <p>Мова: {video.defaultLanguage ?? 'не вказана'} · Категорія YouTube: {video.categoryId ?? '—'}</p>
            {video.tags.length > 0 && <p>Теги: {video.tags.join(', ')}</p>}
            <p>ID: <code>{video.videoId}</code></p>
          </details>
        </div>
      </li>)}
    </ol>
    <nav className="channel-pagination" aria-label="Сторінки відео">
      {data.previousPageToken && <Link rel="prev" href={pageHref(data.previousPageToken)}>← Новіші відео</Link>}
      {data.nextPageToken && <Link rel="next" href={pageHref(data.nextPageToken)}>Старіші відео →</Link>}
      {pageToken && <Link href="/editorial/youtube-channel">На початок списку</Link>}
    </nav>
  </>;
}
