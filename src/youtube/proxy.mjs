import { fetch as undiciFetch, ProxyAgent } from 'undici';

// Outbound proxy for reading YouTube captions, ported from roadscout's registry proxy (originally
// cargo-tracker): YouTube refuses datacenter IPs (Vercel) with LOGIN_REQUIRED, and some Shariy videos
// are geo-blocked in Ukraine, so captions are fetched through a rotating proxy outside Ukraine.
// Priority: YOUTUBE_CAPTIONS_PROXY_URL → Webshare variables → nothing (direct).
// HTTPS_PROXY is deliberately not used here: it would also reroute unrelated traffic.

function truthy(value, fallback) {
  if (value === undefined) return fallback;
  return !['0', 'false', 'no', 'off'].includes(String(value).trim().toLowerCase());
}

// Webshare backbone: http://{username}[-{country}][-rotate]:{password}@p.webshare.io:80
export function webshareProxyUrl(env = process.env) {
  const user = env.WEBSHARE_PROXY_USERNAME, pass = env.WEBSHARE_PROXY_PASSWORD;
  if (!user || !pass) return null;
  const host = env.WEBSHARE_PROXY_HOST || 'p.webshare.io';
  const port = env.WEBSHARE_PROXY_PORT || '80';
  const country = (env.WEBSHARE_PROXY_COUNTRY || '').trim().toLowerCase();
  let name = user;
  if (country) name += `-${country}`;
  if (truthy(env.WEBSHARE_PROXY_ROTATE, true)) name += '-rotate';
  return `http://${encodeURIComponent(name)}:${encodeURIComponent(pass)}@${host}:${port}`;
}

export function captionsProxyUrl(env = process.env) {
  return env.YOUTUBE_CAPTIONS_PROXY_URL || webshareProxyUrl(env) || null;
}

// host:port only — never credentials — for logs.
export function proxyHostForDisplay(url) {
  try { const u = new URL(url); return u.port ? `${u.hostname}:${u.port}` : u.hostname; } catch { return null; }
}

// Safe description of a proxy failure for logs: error codes and the proxy's HTTP status, never credentials.
export function proxyFailureDetail(error) {
  const codes = [], messages = [];
  for (let e = error, depth = 0; e && depth < 5; e = e.cause, depth++) {
    if (e.code) codes.push(String(e.code));
    if (e.message) messages.push(String(e.message));
  }
  const text = messages.join(' | ');
  const status = Number(/proxy response \((\d{3})\)/i.exec(text)?.[1]) || null;
  return { codes:[...new Set(codes)].slice(0, 4), status,
    message:text.replace(/[a-z][\w+.-]*:\/\/[^@\s/]+@/gi, '***@').slice(0, 160) };
}

// The proxy itself failed (unreachable, auth refused) — as opposed to YouTube answering through it.
export function isProxyFailure(error) {
  const codes = new Set(['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'EPROTO',
    'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET']);
  for (let e = error; e; e = e.cause) {
    if (codes.has(e.code)) return true;
    if (/proxy response \(40[37]\)|Proxy-Authenticate|407/i.test(String(e.message ?? ''))) return true;
  }
  return false;
}

let cached = { url:undefined, agent:null };

/**
 * fetch that goes through the configured proxy and retries once directly if the proxy itself is down.
 * Without a proxy it is plain fetch. Returns the fetch plus a description for logs.
 */
export function captionsFetch(env = process.env, { baseFetch = fetch, proxiedFetch = undiciFetch, makeAgent = url => new ProxyAgent(url), onProxyDown } = {}) {
  const url = captionsProxyUrl(env);
  if (!url) return { fetchImpl:baseFetch, via:'direct' };
  if (cached.url !== url) cached = { url, agent:makeAgent(url) };
  const agent = cached.agent;
  const host = proxyHostForDisplay(url);
  const fetchImpl = async (input, init = {}) => {
    try {
      return await proxiedFetch(input, { ...init, dispatcher:agent });
    } catch (error) {
      if (!isProxyFailure(error)) throw error;
      // Callers get only the HTTP status and error codes — never credentials or exception text.
      const { status, codes } = proxyFailureDetail(error);
      onProxyDown?.({ proxy:host, status, codes });
      console.warn('YOUTUBE_CAPTIONS_PROXY_DOWN', { proxy:host, status, codes });
      return baseFetch(input, init);
    }
  };
  return { fetchImpl, via:'proxy ' + host };
}
