/**
 * llm-config/safe-fetch.ts — SSRF 防护的受限 fetch。
 *
 * 规则：
 *   - https 放开（公网 LLM 都是 https）
 *   - http 仅允许本机回环（127.0.0.1 / localhost / host.docker.internal，本地 Ollama 等场景）
 *   - 拒绝其它 scheme（file:、gopher: 等）与 URL 内嵌凭据（user:pass@host）
 *   - redirect: 'manual'，逐跳重新校验，最多 3 跳
 *   - 15s 超时；响应体上限 1 MiB
 */
export const LLM_TEST_TIMEOUT_MS = 15_000;
export const LLM_TEST_MAX_BODY_BYTES = 1024 * 1024;
const MAX_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const LOCAL_HTTP_HOSTS = new Set(['127.0.0.1', 'localhost', 'host.docker.internal']);

export type ConnectUrlCheck = { ok: true; url: URL } | { ok: false; reason: string };

/** 纯校验：该 URL 是否允许面板进程发起连接。 */
export function isAllowedConnectUrl(raw: string): ConnectUrlCheck {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'INVALID_URL' };
  }
  if (url.protocol === 'https:') {
    /* allowed */
  } else if (url.protocol === 'http:') {
    if (!LOCAL_HTTP_HOSTS.has(url.hostname)) {
      return { ok: false, reason: 'HTTP_ONLY_LOCAL' };
    }
  } else {
    return { ok: false, reason: 'UNSAFE_URL_SCHEME' };
  }
  if (url.username || url.password) {
    return { ok: false, reason: 'CREDENTIALS_IN_URL' };
  }
  return { ok: true, url };
}

export interface SafeFetchResult {
  ok: boolean;
  status: number;
  endpoint: string;
  bodyText: string;
  finalUrl: string;
  redirectsFollowed: number;
  truncatedResponse: boolean;
  error?: string;
}

function failure(endpoint: string, finalUrl: string, redirects: number, error: string): SafeFetchResult {
  return {
    ok: false,
    status: 0,
    endpoint,
    bodyText: '',
    finalUrl,
    redirectsFollowed: redirects,
    truncatedResponse: false,
    error,
  };
}

/** 受限抓取。init 里勿带 signal/redirect（由本函数管理）。 */
export async function safeFetch(rawUrl: string, init: Omit<RequestInit, 'signal' | 'redirect'>): Promise<SafeFetchResult> {
  let current = rawUrl;
  let redirects = 0;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const check = isAllowedConnectUrl(current);
    if (!check.ok) return failure(rawUrl, current, redirects, check.reason);

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), LLM_TEST_TIMEOUT_MS);
    try {
      const resp = await fetch(check.url, { ...init, redirect: 'manual', signal: ctrl.signal });
      if (REDIRECT_STATUSES.has(resp.status)) {
        const loc = resp.headers.get('location');
        if (!loc) return failure(rawUrl, current, redirects, 'REDIRECT_WITHOUT_LOCATION');
        current = new URL(loc, check.url).toString();
        redirects += 1;
        continue;
      }
      const text = await resp.text();
      const truncatedResponse = text.length > LLM_TEST_MAX_BODY_BYTES;
      return {
        ok: resp.ok,
        status: resp.status,
        endpoint: rawUrl,
        bodyText: truncatedResponse ? text.slice(0, LLM_TEST_MAX_BODY_BYTES) : text,
        finalUrl: check.url.toString(),
        redirectsFollowed: redirects,
        truncatedResponse,
      };
    } catch (err) {
      const timedOut = err instanceof Error && err.name === 'AbortError';
      return failure(rawUrl, current, redirects, timedOut ? 'TIMEOUT' : 'FETCH_ERROR');
    } finally {
      clearTimeout(timer);
    }
  }
  return failure(rawUrl, current, redirects, 'TOO_MANY_REDIRECTS');
}