/**
 * api/llm-config.ts — LLM 配置模块专属业务路由（/api/v1/llm-config/*）。
 *
 * 与 chat-memory.ts 同款主题：从 panelSession 注入 X-Tdai-Service-Id / X-Tdai-User-Key，
 * 解包 MetaEnvelope。api_key 只出现在请求方向；响应类型不含明文 key。
 */
import { getPanelSession } from '../panelSession';
import { request, ApiError } from './base';
import type { MetaEnvelope } from './types';

// ── 领域类型（与 BFF routes/llm-config 契约一致）──

export type LlmProtocol = 'openai' | 'anthropic';
export type LlmConfigTarget = 'memory' | 'proxy' | 'knowledge';
export type BindingMode = 'proxy' | 'byo';

export interface TestConnectionInput {
  protocol: LlmProtocol;
  base_url: string;
  api_key: string;
  model?: string;
}

export interface ConnectionTestResult {
  ok: boolean;
  protocol: LlmProtocol;
  endpoint: string;
  httpStatus: number;
  message: string;
  modelRecognized: boolean | null;
  warnings: string[];
  errors: string[];
  redirectsFollowed?: number;
  truncatedResponse?: boolean;
}

export interface CompatibilityInput {
  target: LlmConfigTarget;
  base_url?: string;
  api_key?: string;
  model?: string;
  protocol?: LlmProtocol;
  mode?: BindingMode;
  proxy_base_url?: string;
  enabled?: boolean;
}

export interface CompatibilityWarning {
  code: string;
  message: string;
}

export interface CompatibilityResult {
  ok: boolean;
  target: LlmConfigTarget;
  restart_required: boolean;
  live_update: boolean;
  env_vars: string[];
  errors: string[];
  warnings: CompatibilityWarning[];
}

export interface KnowledgeBindingView {
  bound: boolean;
  mode: BindingMode | null;
  proxy_base_url: string | null;
  base_url: string | null;
  has_api_key: boolean;
  enabled: boolean;
}

export interface KnowledgeBindingSetInput {
  mode: BindingMode;
  proxy_base_url?: string;
  base_url?: string;
  api_key?: string;
  enabled?: boolean;
}

export interface KnowledgeBindingSetResult {
  service_id: string;
  mode: BindingMode;
  enabled: boolean;
  updated_at: string;
}

const LLM_CONFIG_PREFIX = '/api/v1/llm-config';

async function llmConfigCall<T>(
  endpoint: string,
  body: unknown = undefined,
): Promise<T> {
  const session = getPanelSession();
  if (!session) throw new ApiError(401, 'Unauthorized', 'no active panel session');
  const envelope = await request<MetaEnvelope<T>>(
    'POST',
    `${LLM_CONFIG_PREFIX}/${endpoint}`,
    body,
    {
      'X-Tdai-Service-Id': session.instanceId,
      'X-Tdai-User-Key': session.userKey,
    },
  );
  if (envelope.code !== 0) {
    throw new ApiError(200, envelope.message, '', {
      code: envelope.code,
      requestId: envelope.request_id,
      rawMessage: envelope.message,
    });
  }
  return envelope.data as T;
}

export const llmConfigApi = {
  /** 面板进程内发起 LLM 连接测试（SSRF 防护 + 响应脱敏）。 */
  test: (input: TestConnectionInput) => llmConfigCall<ConnectionTestResult>('test', input),
  /** 纯本地兼容性评估：字段齐备 + 生效边界（restart/live）。 */
  compatibility: (input: CompatibilityInput) =>
    llmConfigCall<CompatibilityResult>('compatibility', input),
  /** 读当前实例的 knowledge llm-binding（KS /list 过滤，无跨实例泄露）。 */
  getKnowledgeBinding: () => llmConfigCall<KnowledgeBindingView>('knowledge-binding/get'),
  /** 实时保存 knowledge llm-binding（api_key 留空 = 保留已存 key）。 */
  setKnowledgeBinding: (input: KnowledgeBindingSetInput) =>
    llmConfigCall<KnowledgeBindingSetResult>('knowledge-binding/set', input),
};