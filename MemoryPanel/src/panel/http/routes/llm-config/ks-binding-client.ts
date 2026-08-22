/**
 * llm-config/ks-binding-client.ts — 面板 → Knowledge Service 的 llm-binding 内部调用。
 *
 * 复制自 startup/ensure-knowledge-llm-binding.ts:55-84 的 ksPost 形态（该函数为模块私有），
 * 配置来源与 PanelDeps 工厂一致：deps.config.knowledge.{baseUrl,authToken,timeoutMs}。
 *
 * 契约（MemoryKnowledge/src/routes/llm-binding.ts）：
 *   - /list 不要求 service-id 头，返回全部 binding（含 has_api_key，无明文 key）
 *   - /set  必须带 x-tdai-service-id；api_key 首次必填，留空=保留原值；响应不含 key
 */
export interface KsClientOpts {
  baseUrl: string;
  authToken: string;
  timeoutMs: number;
}

interface KsEnvelope<T> {
  code?: number;
  message?: string;
  data?: T;
}

/** KS 上游错误：携带 envelope code（400-599 原样透传给前端）。 */
export class KsUpstreamError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'KsUpstreamError';
  }
}

async function ksPost<T>(opts: KsClientOpts, path: string, serviceId: string, body: unknown): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs);
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (serviceId) headers['x-tdai-service-id'] = serviceId;
    if (opts.authToken) headers.Authorization = `Bearer ${opts.authToken}`;
    const resp = await fetch(`${opts.baseUrl.replace(/\/+$/, '')}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body ?? {}),
      signal: ctrl.signal,
    });
    const json = (await resp.json().catch(() => null)) as KsEnvelope<T> | null;
    if (!json || (json.code !== undefined && json.code !== 0)) {
      const code = json?.code;
      const status = code !== undefined && code >= 400 && code < 600 ? code : resp.status;
      throw new KsUpstreamError(status, json?.message || `KS ${path} failed (http ${resp.status})`);
    }
    return json.data as T;
  } finally {
    clearTimeout(timer);
  }
}

export interface KsBindingSnapshot {
  service_id: string;
  mode: 'proxy' | 'byo' | null;
  proxy_base_url: string | null;
  base_url: string | null;
  has_api_key: boolean;
  enabled: boolean;
}

export async function ksListBindings(opts: KsClientOpts): Promise<KsBindingSnapshot[]> {
  const res = await ksPost<{ items?: KsBindingSnapshot[] }>(opts, '/v3/internal/llm-binding/list', '', {});
  return res.items ?? [];
}

export interface KsBindingSetInput {
  mode: 'proxy' | 'byo';
  proxy_base_url?: string;
  base_url?: string;
  api_key?: string;
  enabled?: boolean;
}

export interface KsBindingSetResult {
  service_id: string;
  mode: 'proxy' | 'byo';
  enabled: boolean;
  updated_at: string;
}

export async function ksSetBinding(opts: KsClientOpts, serviceId: string, input: KsBindingSetInput): Promise<KsBindingSetResult> {
  const body: Record<string, unknown> = { mode: input.mode };
  if (input.proxy_base_url) body.proxy_base_url = input.proxy_base_url;
  if (input.base_url) body.base_url = input.base_url;
  // api_key 留空 = 不传 → KS 保留已存 key
  if (input.api_key) body.api_key = input.api_key;
  if (input.enabled !== undefined) body.enabled = input.enabled;
  return ksPost<KsBindingSetResult>(opts, '/v3/internal/llm-binding/set', serviceId, body);
}