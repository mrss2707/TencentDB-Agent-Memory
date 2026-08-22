/**
 * llm-config/logic.ts — 纯函数（无 I/O）：归一化 / 脱敏 / 兼容性评估。
 * 独立导出便于单测，不依赖 PanelDeps。
 */
import type { CompatibilityRequest, TestRequest } from './schemas.js';
import { isAllowedConnectUrl } from './safe-fetch.js';

export type Protocol = 'openai' | 'anthropic';
export type Target = 'memory' | 'proxy' | 'knowledge';

// ── URL 归一化 ──

/** 去首尾空白 + 去尾部斜杠（不对路径做其它猜测）。 */
export function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
}

// ── API key 脱敏 ──

/** 短 key 全掩；长 key 只露头尾 4 字符。 */
export function maskApiKey(key: string): string {
  if (!key) return '';
  if (key.length <= 8) return '****';
  return `${key.slice(0, 4)}****${key.slice(-4)}`;
}

/** 把文本中出现的 key 明文全部替换为 ****（用于回显 provider 错误体）。 */
export function redactSnippet(text: string, key: string): string {
  if (!key) return text;
  // 只对足够长的 key 做替换，避免 **** 把普通英文短词抹掉
  if (key.length < 6) return text;
  return text.split(key).join('****');
}

// ── 兼容性评估 ──

export interface CompatibilityWarning {
  code: string;
  message: string;
}

export interface CompatibilityResult {
  ok: boolean;
  target: Target;
  /** 改动需要改 deploy/global-images/.env 并重启容器 */
  restart_required: boolean;
  /** 可通过 KS /llm-binding/set 实时生效 */
  live_update: boolean;
  /** 对应 .env 变量名（restart_required=true 时用于生成 snippet） */
  env_vars: string[];
  errors: string[];
  warnings: CompatibilityWarning[];
}

const MEMORY_ENV_VARS = ['MEMORY_LLM_BASE_URL', 'MEMORY_LLM_API_KEY', 'MEMORY_LLM_MODEL', 'MEMORY_LLM_PROTOCOL'];
const PROXY_ENV_VARS = ['PROXY_UPSTREAM_URL', 'PROXY_UPSTREAM_API_KEY', 'PROXY_UPSTREAM_MODEL'];

function urlError(raw: string): string | null {
  if (!raw) return 'LLMURL_REQUIRED';
  const check = isAllowedConnectUrl(raw);
  if (!check.ok) return check.reason;
  return null;
}

function baseResult(target: Target): CompatibilityResult {
  return { ok: true, target, restart_required: false, live_update: false, env_vars: [], errors: [], warnings: [] };
}

/** 纯推演：字段齐备性 + URL 协议 + 每目标的生效边界（不改任何状态）。 */
export function assessCompatibility(input: CompatibilityRequest): CompatibilityResult {
  const result = baseResult(input.target);

  if (input.target === 'memory') {
    result.restart_required = true;
    result.env_vars = MEMORY_ENV_VARS;
    const urlErr = urlError(input.base_url);
    if (urlErr) result.errors.push(urlErr);
    if (!input.api_key) result.errors.push('LLM_API_KEY_REQUIRED');
    if (!input.model) result.errors.push('LLM_MODEL_REQUIRED');
    if (!input.protocol) result.errors.push('LLM_PROTOCOL_REQUIRED');
  } else if (input.target === 'proxy') {
    result.restart_required = true;
    result.env_vars = PROXY_ENV_VARS;
    const urlErr = urlError(input.base_url);
    if (urlErr) result.errors.push(urlErr);
    if (!input.api_key) result.errors.push('LLM_API_KEY_REQUIRED');
    if (!input.model) result.errors.push('LLM_MODEL_REQUIRED');
    if (input.protocol) {
      result.warnings.push({
        code: 'PROXY_PROTOCOL_IGNORED',
        message: 'proxy 转发沿用请求方协议（OpenAI 语义），.env 无 PROXY 协议变量；此测试仅按所选协议发包',
      });
    }
  } else {
    // knowledge：仅 binding 字段实时生效；model/protocol 系全局 LLM_* env
    result.live_update = true;
    if (!input.mode) {
      result.errors.push('BINDING_MODE_REQUIRED');
    } else if (input.mode === 'proxy') {
      const urlErr = urlError(input.proxy_base_url);
      if (urlErr) result.errors.push(urlErr);
    } else {
      const urlErr = urlError(input.base_url);
      if (urlErr) result.errors.push(urlErr);
    }
    if (!input.api_key) {
      result.warnings.push({
        code: 'BINDING_KEY_FIRST_SET',
        message: '首次保存必须提供 api_key；留空则保留当前已存 key',
      });
    }
    result.warnings.push({
      code: 'KNOWLEDGE_MODEL_PROTOCOL_GLOBAL',
      message: 'knowledge 的 model/protocol 来自全局 LLM_* 环境变量（非按实例存储）；改它们需改 .env 并重启 memory-hub',
    });
  }

  result.ok = result.errors.length === 0;
  return result;
}

// ── 连接测试结果类型（与 llm-test.ts 共用） ──

export interface ConnectionTestResult {
  ok: boolean;
  protocol: Protocol;
  /** 实际请求的完整端点（用户自填，无密钥） */
  endpoint: string;
  httpStatus: number;
  /** 已脱敏的说明/错误消息 */
  message: string;
  /** openai：models 列表是否含所选 model；其余协议恒为 null */
  modelRecognized: boolean | null;
  warnings: string[];
  errors: string[];
  /** 跟随重定向的次数 */
  redirectsFollowed?: number;
  /** 响应体超过 1 MiB 被截断 */
  truncatedResponse?: boolean;
}

export type { TestRequest };