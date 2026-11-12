import { randomUUID } from 'node:crypto';
import { importTranscript, registerVideo } from '../db/editorial-import.mjs';

const transcriptLimit = 2 * 1024 * 1024;
const inputErrors = new Set([
  'INVALID_YOUTUBE_URL', 'INVALID_INPUT', 'UNSUPPORTED_FORMAT', 'INVALID_UTF8',
  'INVALID_TRANSCRIPT', 'INVALID_VTT_HEADER', 'INVALID_CUE', 'INVALID_TIMECODE',
  'INVALID_CUE_INTERVAL', 'EMPTY_TRANSCRIPT',
]);

async function readBody(request, limit) {
  if (Number(request.headers.get('content-length')) > limit) {
    throw new Error('BODY_TOO_LARGE');
  }
  const reader = request.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks, size);
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => {});
        throw new Error('BODY_TOO_LARGE');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
}

/** authorize returns an active editor or a denial. Target access and duration
 * come from the server-side authorization adapter, never from the request body. */
export function createEditorialImportHandler({ db, authorize, allowedOrigin }) {
  if (typeof authorize !== 'function' || !allowedOrigin) {
    throw new Error('IMPORT_AUTH_CONFIGURATION_REQUIRED');
  }

  return async function handle(request) {
    const requestId = randomUUID();
    const headers = { 'Cache-Control': 'private, no-store' };
    const failure = (status, code, message) =>
      Response.json({ error: { code, message, requestId } }, { status, headers });
    const url = new URL(request.url);
    const videoRoute = url.pathname === '/api/videos';
    const transcriptRoute = /^\/api\/videos\/([0-9a-f-]{36})\/transcripts$/i.exec(url.pathname);
    if (!videoRoute && !transcriptRoute) return failure(404, 'NOT_FOUND', 'Маршрут не знайдено.');
    if (request.method !== 'POST') return failure(405, 'METHOD_NOT_ALLOWED', 'Потрібен POST.');
    if (request.headers.get('origin') !== allowedOrigin) {
      return failure(403, 'ORIGIN_DENIED', 'Запит з цього сайту заборонено.');
    }

    const videoId = transcriptRoute?.[1];
    if (videoId && !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(videoId)) {
      return failure(422, 'INVALID_VIDEO_ID', 'Некоректний ідентифікатор відео.');
    }

    try {
      const access = await authorize(request, { videoId });
      if (!access?.actorId) return failure(401, 'AUTH_REQUIRED', 'Увійдіть до редакції.');
      if (access.canImport !== true) return failure(403, 'FORBIDDEN', 'Доступ заборонено.');

      let data;
      if (videoRoute) {
        let body;
        const bytes = await readBody(request, 8192);
        try {
          body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        } catch {
          return failure(422, 'INVALID_JSON', 'Некоректне тіло запиту.');
        }
        data = await registerVideo(db, body?.url);
      } else {
        data = await importTranscript(db, {
          videoId,
          bytes: await readBody(request, transcriptLimit),
          format: url.searchParams.get('format'),
          durationMs: access.durationMs,
        });
      }
      return Response.json({ data }, { headers });
    } catch (error) {
      const code = error?.message;
      if (inputErrors.has(code)) return failure(422, code, 'Перевірте формат вхідних даних.');
      if (code === 'BODY_TOO_LARGE') return failure(413, code, 'Файл або запит завеликий.');
      if (code === 'VIDEO_NOT_FOUND') return failure(404, code, 'Відео не знайдено.');
      return failure(500, 'IMPORT_FAILED', 'Імпорт не вдалося завершити.');
    }
  };
}
