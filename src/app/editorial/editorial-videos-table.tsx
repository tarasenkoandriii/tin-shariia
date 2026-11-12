'use client';

import Link from 'next/link';
import { useCallback, useState } from 'react';

type Video = { id: string; youtubeId: string; createdAt: string };
type SortKey = 'youtubeId' | 'createdAt';

const dateFormat = new Intl.DateTimeFormat('uk-UA', {
  dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Kyiv',
});
const columns: { key: SortKey; label: string }[] = [
  { key: 'youtubeId', label: 'ID YouTube' },
  { key: 'createdAt', label: 'Додано до редакції' },
];

function VideoPreview({ youtubeId }: { youtubeId: string }) {
  const [unavailable, setUnavailable] = useState(false);
  const checkPreview = useCallback((image: HTMLImageElement | null) => {
    if (image?.complete && image.naturalWidth < 128) setUnavailable(true);
  }, []);
  return <span className="editorial-video-preview">
    {unavailable ? <span>Немає прев’ю</span> :
      /* eslint-disable-next-line @next/next/no-img-element -- Public YouTube thumbnail with a local fallback. */
      <img ref={checkPreview} src={`https://i.ytimg.com/vi/${encodeURIComponent(youtubeId)}/mqdefault.jpg`}
        width={128} height={72} alt="" loading="lazy" referrerPolicy="no-referrer"
        onLoad={event => {
          if (event.currentTarget.naturalWidth < 128) setUnavailable(true);
        }}
        onError={() => setUnavailable(true)} />}
  </span>;
}

export function EditorialVideosTable({ videos }: { videos: Video[] }) {
  const [sort, setSort] = useState<{ key: SortKey; direction: 'ascending' | 'descending' }>({
    key: 'createdAt', direction: 'descending',
  });
  const sorted = [...videos].sort((a, b) => {
    const comparison = a[sort.key].localeCompare(b[sort.key]);
    return comparison * (sort.direction === 'ascending' ? 1 : -1) || a.id.localeCompare(b.id);
  });

  return <div className="editorial-video-scroll" role="region" aria-label="Таблиця відео" tabIndex={0}>
    <table className="editorial-video-table" aria-label="Відео редакції">
      <thead><tr>
        <th scope="col">Прев’ю</th>
        {columns.map(({ key, label }) => <th key={key} scope="col" aria-sort={sort.key === key ? sort.direction : undefined}>
          <button type="button" onClick={() => setSort(previous => ({
            key,
            direction: previous.key === key
              ? (previous.direction === 'ascending' ? 'descending' : 'ascending')
              : (key === 'createdAt' ? 'descending' : 'ascending'),
          }))}>
            {label} <span aria-hidden="true">{sort.key === key ? (sort.direction === 'ascending' ? '↑' : '↓') : '↕'}</span>
          </button>
        </th>)}
      </tr></thead>
      <tbody>{sorted.map(video => <tr key={video.id}>
        <td><VideoPreview youtubeId={video.youtubeId} /></td>
        <td><Link href={'/editorial/videos/' + video.id}>{video.youtubeId}</Link></td>
        <td><time dateTime={video.createdAt}>{dateFormat.format(new Date(video.createdAt))}</time></td>
      </tr>)}</tbody>
    </table>
  </div>;
}
