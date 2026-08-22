/**
 * llm-config/llm-test.ts — LLM 连接测试执行器。
 *
 * 语义对齐 deploy/global-images/README.md「LLM 通路预检」与 verify.sh：
 *   - openai   : GET {base}/models（Bearer，不消耗 token）；可选核对 model 是否在列表中
 *   - anthropic: POST {base}/v1/messages 最小消息（x-api-key + anthropic-version + max_tokens:1）
 *
 * 所有回显的 provider 文本都经 redactSnippet 脱敏；结果不含 api_key。
 */
import { normalizeBaseUrl, redactSnippet, type ConnectionTestResult, type Protocol } from './logic.js';
import type { TestRequest } from './schemas.js';
import { safeFetch } from './safe-fetch.js';

const ANTHROPIC_VERSION = '2023-06-01';

function baseResult(req: TestRequest): ConnectionTestResult {
  return {
    ok: false,
    protocol: req.protocol,
    endpoint: '',
    httpStatus: 0,
    message: '',
    modelRecognized: null,
    warnings: [],
    errors: [],
  };
}

function describeError(status: number, redacted: string): string {
  if (status === 401 || status === 403) return `认证失败（HTTP ${status}），请检查 API key`;
  if (status === 404) return `端点不存在（HTTP 404），请检查 Base URL`;
  if (status === 429) return '限流（HTTP 429），请稍后重试';
  const snippet = redacted.slice(0, 300);
  return `上游返回 HTTP ${status}${snippet ? `：${snippet}` : ''}`;
}

async function testOpenai(req: TestRequest): Promise<ConnectionTestResult> {
  const result = baseResult(req);
  const base = normalizeBaseUrl(req.base_url);
  result.endpoint = `${base}/models`;

  const resp = await safeFetch(result.endpoint, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      ...(req.api_key ? { Authorization: `Bearer ${req.api_key}` } : {}),
    },
  });
  result.httpStatus = resp.status;
  result.redirectsFollowed = resp.redirectsFollowed;
  result.truncatedResponse = resp.truncatedResponse;
  if (resp.error) {
    result.errors.push(resp.error);
    result.message = resp.error;
    return result;
  }
  if (!resp.ok) {
    const redacted = redactSnippet(resp.bodyText, req.api_key);
    result.message = describeError(resp.status, redacted);
    result.errors.push(result.message);
    return result;
  }

  try {
    const json = JSON.parse(resp.bodyText) as { data?: Array<{ id?: string }> };
    const ids = (json.data ?? []).map((m) => m.id ?? '').filter(Boolean);
    if (req.model) {
      result.modelRecognized = ids.includes(req.model);
      if (!result.modelRecognized) {
        result.warnings.push(`model "${req.model}" 未出现在 /models 列表（可用：${ids.slice(0, 5).join(', ')}${ids.length > 5 ? '…' : ''}）`);
      }
    }
    result.ok = true;
    result.message = '连接成功';
  } catch {
    result.ok = true;
    result.message = '连接成功（响应体非标准 JSON，未核对 model 列表）';
  }
  return result;
}

async function testAnthropic(req: TestRequest): Promise<ConnectionTestResult> {
  const result = baseResult(req);
  const base = normalizeBaseUrl(req.base_url);
  // {base} 已含 /v1 时不再重复拼接
  result.endpoint = base.endsWith('/v1') ? `${base}/messages` : `${base}/v1/messages`;

  if (!req.model) {
    result.errors.push('ANTHROPIC_MODEL_REQUIRED');
    result.message = 'anthropic 协议测试必须提供 model';
    return result;
  }
  if (!req.api_key) {
    result.errors.push('ANTHROPIC_API_KEY_REQUIRED');
    result.message = 'anthropic 协议测试必须提供 API key';
    return result;
  }

  const resp = await safeFetch(result.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': req.api_key,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: req.model,
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ping' }],
    }),
  });
  result.httpStatus = resp.status;
  result.redirectsFollowed = resp.redirectsFollowed;
  result.truncatedResponse = resp.truncatedResponse;
  if (resp.error) {
    result.errors.push(resp.error);
    result.message = resp.error;
    return result;
  }
  if (!resp.ok) {
    const redacted = redactSnippet(resp.bodyText, req.api_key);
    result.message = describeError(resp.status, redacted);
    result.errors.push(result.message);
    return result;
  }
  result.ok = true;
  result.message = '连接成功（已完成最小消息往返）';
  return result;
}

/** 协议分发入口。仅在面板进程内发起请求（不经浏览器直连）。 */
export async function runConnectionTest(req: TestRequest): Promise<ConnectionTestResult> {
  if (req.protocol === 'openai') return testOpenai(req);
  return testAnthropic(req);
}

export type { Protocol };