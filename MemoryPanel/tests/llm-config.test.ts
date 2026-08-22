import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { PanelDeps } from '../src/panel/panel-deps';
import { registerLlmConfigRoutes } from '../src/panel/http/routes/llm-config/index';
import {
  assessCompatibility,
  maskApiKey,
  normalizeBaseUrl,
  redactSnippet,
} from '../src/panel/http/routes/llm-config/logic';
import { runConnectionTest } from '../src/panel/http/routes/llm-config/llm-test';
import { isAllowedConnectUrl, safeFetch } from '../src/panel/http/routes/llm-config/safe-fetch';
import { ksListBindings } from '../src/panel/http/routes/llm-config/ks-binding-client';

const KEY = 'sk-abcdef1234567890xyz';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── logic 纯函数 ──

describe('logic helpers', () => {
  it('normalizeBaseUrl trims and strips trailing slashes', () => {
    expect(normalizeBaseUrl('  https://api.openai.com/v1///  ')).toBe('https://api.openai.com/v1');
    expect(normalizeBaseUrl('https://x.ai')).toBe('https://x.ai');
  });

  it('maskApiKey hides short keys entirely and long keys keep only ends', () => {
    expect(maskApiKey('abc')).toBe('****');
    expect(maskApiKey('sk-verylongsecretkey')).toBe('sk-v****tkey');
    expect(maskApiKey('')).toBe('');
  });

  it('redactSnippet replaces key occurrences and ignores short keys', () => {
    expect(redactSnippet(`Bad key ${KEY} again ${KEY}`, KEY)).toBe('Bad key **** again ****');
    expect(redactSnippet('short key test', 'key')).toBe('short key test');
  });
});

describe('assessCompatibility', () => {
  const good = {
    base_url: 'https://api.openai.com',
    api_key: KEY,
    model: 'gpt-4o',
  };

  it('memory: complete config is ok and restart-required', () => {
    const r = assessCompatibility({ target: 'memory', ...good, protocol: 'openai' });
    expect(r.ok).toBe(true);
    expect(r.restart_required).toBe(true);
    expect(r.live_update).toBe(false);
    expect(r.env_vars).toEqual(['MEMORY_LLM_BASE_URL', 'MEMORY_LLM_API_KEY', 'MEMORY_LLM_MODEL', 'MEMORY_LLM_PROTOCOL']);
  });

  it('memory: missing fields and unsafe urls produce errors', () => {
    const r = assessCompatibility({ target: 'memory', base_url: 'http://evil.example.com', api_key: '', model: '', protocol: undefined });
    expect(r.ok).toBe(false);
    expect(r.errors).toContain('HTTP_ONLY_LOCAL');
    expect(r.errors).toContain('LLM_API_KEY_REQUIRED');
    expect(r.errors).toContain('LLM_MODEL_REQUIRED');
    expect(r.errors).toContain('LLM_PROTOCOL_REQUIRED');
  });

  it('proxy: protocol only warns (no proxy protocol env var)', () => {
    const r = assessCompatibility({ target: 'proxy', ...good, protocol: 'anthropic' });
    expect(r.ok).toBe(true);
    expect(r.restart_required).toBe(true);
    expect(r.env_vars).toEqual(['PROXY_UPSTREAM_URL', 'PROXY_UPSTREAM_API_KEY', 'PROXY_UPSTREAM_MODEL']);
    expect(r.warnings.some((w) => w.code === 'PROXY_PROTOCOL_IGNORED')).toBe(true);
  });

  it('knowledge: proxy mode requires proxy_base_url; byo checks base_url', () => {
    const r1 = assessCompatibility({ target: 'knowledge', mode: 'proxy', proxy_base_url: 'http://127.0.0.1:8096', api_key: KEY });
    expect(r1.ok).toBe(true);
    expect(r1.live_update).toBe(true);
    expect(r1.restart_required).toBe(false);

    const r2 = assessCompatibility({ target: 'knowledge', mode: 'proxy', proxy_base_url: '' });
    expect(r2.errors).toContain('LLMURL_REQUIRED');

    const r3 = assessCompatibility({ target: 'knowledge', mode: 'byo', base_url: 'file:///etc/passwd' });
    expect(r3.errors).toContain('UNSAFE_URL_SCHEME');
  });

  it('knowledge: missing api key warns about first-set requirement', () => {
    const r = assessCompatibility({ target: 'knowledge', mode: 'byo', base_url: 'https://api.openai.com' });
    expect(r.ok).toBe(true);
    expect(r.warnings.some((w) => w.code === 'BINDING_KEY_FIRST_SET')).toBe(true);
    expect(r.warnings.some((w) => w.code === 'KNOWLEDGE_MODEL_PROTOCOL_GLOBAL')).toBe(true);
  });
});

// ── safe-fetch SSRF 防护 ──

describe('isAllowedConnectUrl', () => {
  it('allows https any host', () => {
    expect(isAllowedConnectUrl('https://evil.example.com/v1')).toMatchObject({ ok: true });
  });

  it('allows http only for local host family', () => {
    expect(isAllowedConnectUrl('http://127.0.0.1:11434')).toMatchObject({ ok: true });
    expect(isAllowedConnectUrl('http://localhost:8096/x')).toMatchObject({ ok: true });
    expect(isAllowedConnectUrl('http://host.docker.internal:8096')).toMatchObject({ ok: true });
    expect(isAllowedConnectUrl('http://192.168.1.10:8096')).toMatchObject({ ok: false, reason: 'HTTP_ONLY_LOCAL' });
  });

  it('rejects non-http(s) schemes and embedded credentials', () => {
    expect(isAllowedConnectUrl('file:///etc/passwd')).toMatchObject({ ok: false, reason: 'UNSAFE_URL_SCHEME' });
    expect(isAllowedConnectUrl('gopher://127.0.0.1:70/x')).toMatchObject({ ok: false, reason: 'UNSAFE_URL_SCHEME' });
    expect(isAllowedConnectUrl('https://user:pass@api.openai.com')).toMatchObject({ ok: false, reason: 'CREDENTIALS_IN_URL' });
    expect(isAllowedConnectUrl('not a url')).toMatchObject({ ok: false, reason: 'INVALID_URL' });
  });
});

describe('safeFetch redirect re-validation', () => {
  it('rejects redirects to disallowed schemes', async () => {
    const fetchMock = vi.fn(async () =>
      new Response('moved', { status: 301, headers: { location: 'file:///etc/passwd' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await safeFetch('https://ok.example.com/v1', { method: 'GET' });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('UNSAFE_URL_SCHEME');
    expect(res.redirectsFollowed).toBe(1);
  });

  it('follows an allowed redirect chain and reports the final body', async () => {
    const fetchMock = vi.fn(async (url: unknown) =>
      String(url).includes('hop')
        ? new Response('', { status: 302, headers: { location: 'https://final.example.com/x' } })
        : new Response('hello', { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await safeFetch('https://hop.example.com/a', { method: 'GET' });
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(res.bodyText).toBe('hello');
    expect(res.redirectsFollowed).toBe(1);
  });
});

// ── llm-test（fetch 打桩）──

describe('runConnectionTest', () => {
  it('openai: GET /models with Bearer and recognizes the model', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const r = await runConnectionTest({
      protocol: 'openai',
      base_url: 'https://api.openai.com/v1',
      api_key: KEY,
      model: 'gpt-4o',
    });
    expect(r.ok).toBe(true);
    expect(r.modelRecognized).toBe(true);
    expect(r.endpoint).toBe('https://api.openai.com/v1/models');
    const [url, init] = fetchMock.mock.calls[0] as [unknown, RequestInit];
    expect(String(url)).toBe('https://api.openai.com/v1/models');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
  });

  it('openai: 401 body is redacted and never leaks the key', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: `Invalid key ${KEY}.` } }), { status: 401 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const r = await runConnectionTest({
      protocol: 'openai',
      base_url: 'https://api.openai.com',
      api_key: KEY,
    });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(KEY);
    expect(r.message).not.toContain(KEY);
  });

  it('anthropic: POST v1/messages with x-api-key and minimal body', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ id: 'msg_1', type: 'message' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const r = await runConnectionTest({
      protocol: 'anthropic',
      base_url: 'https://api.anthropic.com',
      api_key: KEY,
      model: 'claude-haiku-4-5-20251001',
    });
    expect(r.ok).toBe(true);
    expect(r.endpoint).toBe('https://api.anthropic.com/v1/messages');
    const [url, init] = fetchMock.mock.calls[0] as [unknown, RequestInit];
    expect(String(url)).toBe('https://api.anthropic.com/v1/messages');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe(KEY);
    expect(headers['anthropic-version']).toBe('2023-06-01');
    const body = JSON.parse(String(init.body)) as { model: string; max_tokens: number; messages: unknown[] };
    expect(body.max_tokens).toBe(1);
    expect(body.messages).toHaveLength(1);
  });

  it('anthropic: requires model and api key before any network call', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const noModel = await runConnectionTest({ protocol: 'anthropic', base_url: 'https://api.anthropic.com', api_key: KEY });
    expect(noModel.errors).toContain('ANTHROPIC_MODEL_REQUIRED');

    const noKey = await runConnectionTest({ protocol: 'anthropic', base_url: 'https://api.anthropic.com', api_key: '', model: 'm' });
    expect(noKey.errors).toContain('ANTHROPIC_API_KEY_REQUIRED');

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ── 路由（stubbed PanelDeps + 打桩 KS upstream）──

function buildDeps(overrides?: Partial<{
  ksList: (path: string, init: { method: string; headers: Record<string, string>; body: string }) => Response;
}>) {
  const deps = {
    config: {
      knowledge: {
        baseUrl: 'http://ks.internal:8421',
        authToken: 'ks-token',
        timeoutMs: 5000,
      },
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    instanceRegistry: {
      resolve: (id: string) => ({
        instance_id: id,
        gateway_endpoint: 'http://gw.internal:8420',
        api_key: 'gw-key',
      }),
    },
    metaKernel: {
      invoke: vi.fn(async () => ({
        code: 0,
        message: 'ok',
        request_id: '',
        data: { valid: true, user: { user_id: 'user-1' } },
      })),
    },
    kernelHttp: {},
    knowledgeClientFactory: () => ({}),
    skillKernel: {},
    knowledgeTaskRegistry: {},
    ingestProgressStore: {},
  } as unknown as PanelDeps;

  if (overrides?.ksList) {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: { method: string; headers: Record<string, string>; body: string }) =>
      (overrides.ksList as (path: string, init: { method: string; headers: Record<string, string>; body: string }) => Response)(String(url), init),
    ));
  }
  return deps;
}

function buildApp(deps: PanelDeps) {
  const app = new Hono();
  registerLlmConfigRoutes(app, deps);
  return app;
}

const META_HEADERS = {
  'x-tdai-service-id': 'inst-1',
  'x-tdai-user-key': 'uk-1',
  'content-type': 'application/json',
};

function ksEnvelope(data: unknown) {
  return new Response(JSON.stringify({ code: 0, message: 'ok', data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('llm-config routes', () => {
  it('knowledge-binding/get filters to the current instance and never leaks others', async () => {
    const reqs: string[] = [];
    const deps = buildDeps({
      ksList: (path) => {
        reqs.push(path);
        return ksEnvelope({
          items: [
            { service_id: 'inst-1', mode: 'proxy', proxy_base_url: 'http://proxy-1', base_url: null, has_api_key: true, enabled: true },
            { service_id: 'inst-2', mode: 'byo', proxy_base_url: null, base_url: 'https://secret-other-instance', has_api_key: true, enabled: false },
          ],
        });
      },
    });
    const res = await buildApp(deps).request('/llm-config/knowledge-binding/get', {
      method: 'POST',
      headers: META_HEADERS,
      body: JSON.stringify({}),
    });
    const env = await res.json() as { code: number; data: Record<string, unknown> };
    expect(env.code).toBe(0);
    expect(env.data).toMatchObject({
      bound: true,
      mode: 'proxy',
      proxy_base_url: 'http://proxy-1',
      has_api_key: true,
      enabled: true,
    });
    expect(JSON.stringify(env.data)).not.toContain('secret-other-instance');
    expect(reqs.some((p) => p.includes('/v3/internal/llm-binding/list'))).toBe(true);
  });

  it('knowledge-binding/set keeps key out of request when blank, and response never echoes it', async () => {
    let sentBody: Record<string, unknown> | null = null;
    const deps = buildDeps({
      ksList: (path, init) => {
        if (path.includes('/set')) {
          sentBody = JSON.parse(init.body) as Record<string, unknown>;
          return ksEnvelope({ service_id: 'inst-1', mode: 'proxy', enabled: true, updated_at: '2026-08-21T00:00:00Z' });
        }
        return ksEnvelope({ items: [] });
      },
    });
    const res = await buildApp(deps).request('/llm-config/knowledge-binding/set', {
      method: 'POST',
      headers: META_HEADERS,
      body: JSON.stringify({ mode: 'proxy', proxy_base_url: 'http://127.0.0.1:8096', enabled: true }),
    });
    const env = await res.json() as { code: number; data: Record<string, unknown> };
    expect(env.code).toBe(0);
    expect(sentBody).toBeTruthy();
    expect(sentBody).not.toHaveProperty('api_key');
    expect(JSON.stringify(env.data)).not.toContain(KEY);

    // 显式传 key 时，请求体必须带上（交给 KS 存储）
    await buildApp(deps).request('/llm-config/knowledge-binding/set', {
      method: 'POST',
      headers: META_HEADERS,
      body: JSON.stringify({ mode: 'proxy', proxy_base_url: 'http://127.0.0.1:8096', api_key: KEY }),
    });
    expect(sentBody).toMatchObject({ api_key: KEY });
  });

  it('rejects invalid binding payloads before touching KS', async () => {
    const deps = buildDeps();
    const res = await buildApp(deps).request('/llm-config/knowledge-binding/set', {
      method: 'POST',
      headers: META_HEADERS,
      body: JSON.stringify({ mode: 'proxy', proxy_base_url: '' }),
    });
    const env = await res.json() as { code: number };
    expect(env.code).toBe(400);
    expect(env.code === 400).toBe(true);
  });

  it('requires valid meta headers (missing service id → 400)', async () => {
    const deps = buildDeps();
    const res = await buildApp(deps).request('/llm-config/compatibility', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const env = await res.json() as { code: number };
    expect(env.code).toBe(400);
  });

  it('invalid user key fails auth (401)', async () => {
    const deps = buildDeps();
    (deps.metaKernel.invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ code: 0, message: 'ok', request_id: '', data: { valid: false } });
    const res = await buildApp(deps).request('/llm-config/compatibility', {
      method: 'POST',
      headers: META_HEADERS,
      body: JSON.stringify({ target: 'memory' }),
    });
    const env = await res.json() as { code: number };
    expect(env.code).toBe(401);
  });

  it('compatibility endpoint is pure and returns assessment', async () => {
    const deps = buildDeps();
    const res = await buildApp(deps).request('/llm-config/compatibility', {
      method: 'POST',
      headers: META_HEADERS,
      body: JSON.stringify({ target: 'memory', base_url: 'https://api.openai.com', api_key: KEY, model: 'gpt-4o', protocol: 'openai' }),
    });
    const env = await res.json() as { code: number; data: { ok: boolean; restart_required: boolean } };
    expect(env.code).toBe(0);
    expect(env.data.ok).toBe(true);
    expect(env.data.restart_required).toBe(true);
  });
});

// ── ks-binding-client ──

describe('ks-binding-client', () => {
  it('sends x-tdai-service-id and Bearer token', async () => {
    const seen: Array<[string, { method: string; headers: Record<string, string>; body: string }]> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: { method: string; headers: Record<string, string>; body: string }) => {
      seen.push([url, init]);
      return ksEnvelope({ items: [] });
    }));

    await ksListBindings({ baseUrl: 'http://ks.internal:8421/', authToken: 'tok-1', timeoutMs: 5000 });
    const [url, init] = seen[0] as [string, { method: string; headers: Record<string, string>; body: string }];
    expect(url).toBe('http://ks.internal:8421/v3/internal/llm-binding/list');
    expect(init.headers['x-tdai-service-id']).toBeUndefined();
    expect(init.headers.Authorization).toBe('Bearer tok-1');
  });

  it('maps KS error envelopes to KsUpstreamError with passthrough status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ code: 422, message: 'requires api_key on first set' }), { status: 400 }),
    ));
    await expect(
      import('../src/panel/http/routes/llm-config/ks-binding-client').then((m) =>
        m.ksSetBinding({ baseUrl: 'http://ks', authToken: '', timeoutMs: 1000 }, 'inst-1', { mode: 'byo', base_url: 'https://api.openai.com' }),
      ),
    ).rejects.toMatchObject({ statusCode: 422, message: 'requires api_key on first set' });
  });
});