'use client';

import Link from 'next/link';
import { useCallback, useState } from 'react';

export type EditorialVideo = {
  id: string; youtubeId: string; createdAt: string; title: string; stage: string; label: string; tone: string;
  time: string | null; claims: number; episodes: number;
};
type SortKey = 'title' | 'time' | 'createdAt';

const dateFormat = new Intl.DateTimeFormat('uk-UA', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Kyiv' });
const columns: { key: SortKey; label: string }[] = [
  { key: 'title', label: 'Випуск' },
  { key: 'time', label: 'Остання зміна' },
  { key: 'createdAt', label: 'Додано' },
];

function VideoPreview({ youtubeId }: { youtubeId: string }) {
  const [unavailable, setUnavailable] = useState(false);
  const checkPreview = useCallback((image: HTMLImageElement | null) => {
    if (image?.complete && image.naturalWidth < 128) setUnavailable(true);
  }, []);
  return <span className="ed-thumb">
    {unavailable ? <span>Немає прев’ю</span> :
      /* eslint-disable-next-line @next/next/no-img-element -- Public YouTube thumbnail with a local fallback. */
      <img ref={checkPreview} src={`https://i.ytimg.com/vi/${encodeURIComponent(youtubeId)}/mqdefault.jpg`}
        width={128} height={72} alt="" loading="lazy" referrerPolicy="no-referrer"
        onLoad={event => { if (event.currentTarget.naturalWidth < 128) setUnavailable(true); }}
        onError={() => setUnavailable(true)} />}
  </span>;
}

const value = (video: EditorialVideo, key: SortKey) => key === 'title' ? video.title : (key === 'time' ? video.time ?? video.createdAt : video.createdAt);

export function EditorialVideosTable({ videos }: { videos: EditorialVideo[] }) {
  const [sort, setSort] = useState<{ key: SortKey; direction: 'ascending' | 'descending' }>({ key: 'time', direction: 'descending' });
  const [query, setQuery] = useState('');
  const filter = query.trim().toLowerCase();
  const sorted = videos
    .filter(video => !filter || video.youtubeId.toLowerCase().includes(filter) || video.title.toLowerCase().includes(filter))
    .sort((a, b) => value(a, sort.key).localeCompare(value(b, sort.key), 'uk') * (sort.direction === 'ascending' ? 1 : -1) || a.id.localeCompare(b.id));

  return <>
    <div className="ed-filters">
      <label className="ed-grow">Пошук за назвою або ID YouTube
        <input type="search" value={query} onChange={event => setQuery(event.target.value)} />
      </label>
      <p role="status" className="ed-meta">
        {sorted.length ? `Показано ${sorted.length} із ${videos.length}` : 'За цим запитом відео не знайдено.'}
      </p>
    </div>
    {sorted.length > 0 && <div className="ed-table-wrap" role="region" aria-label="Таблиця відео" tabIndex={0}>
      <table className="ed-table ed-video-table">
        <caption className="ed-visually-hidden">Відео редакції</caption>
        <thead><tr>
          <th scope="col"><span className="ed-visually-hidden">Прев’ю</span></th>
          {columns.map(({ key, label }) => <th key={key} scope="col" aria-sort={sort.key === key ? sort.direction : undefined}>
            <button type="button" className="ed-sort" onClick={() => setSort(previous => ({
              key,
              direction: previous.key === key ? (previous.direction === 'ascending' ? 'descending' : 'ascending') : (key === 'title' ? 'ascending' : 'descending'),
            }))}>
              {label} <span aria-hidden="true">{sort.key === key ? (sort.direction === 'ascending' ? '↑' : '↓') : '↕'}</span>
            </button>
          </th>)}
          <th scope="col">Етап</th>
        </tr></thead>
        <tbody>{sorted.map(video => <tr key={video.id}>
          <td><VideoPreview youtubeId={video.youtubeId} /></td>
          <td className="ed-video-title">
            <Link href={'/editorial/videos/' + video.id}>{video.title}</Link>
            <span className="ed-meta">YouTube {video.youtubeId} · тверджень {video.claims} · сценаріїв {video.episodes}</span>
          </td>
          <td>{video.time ? <time dateTime={video.time}>{dateFormat.format(new Date(video.time))}</time> : '—'}</td>
          <td><time dateTime={video.createdAt}>{dateFormat.format(new Date(video.createdAt))}</time></td>
          <td><span className={'ed-badge ed-tone-' + video.tone}>{video.label}</span></td>
        </tr>)}</tbody>
      </table>
    </div>}
  </>;
}
