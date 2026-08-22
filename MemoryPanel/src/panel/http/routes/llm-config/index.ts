/**
 * llm-config/index.ts — LLM 配置模块 BFF 路由。
 *
 * 挂载：/api/v1/llm-config/{test,compatibility,knowledge-binding/get,knowledge-binding/set}
 *
 * 鉴权同 knowledge 路由主题：validatePanelMetaHeaders（实例注册表 + user-key 头）
 * → requireCaller（auth/verify 验活）。全部走 meta envelope 返回。
 *
 * 安全约定：
 *   - api_key 仅出现于请求方向；任何响应/日志不回显（日志只记 host + 协议）
 *   - 连接测试经 safeFetch（SSRF 防护）；test 端点为通用端点，供 memory/proxy/knowledge 三卡共用
 *   - knowledge-binding 读侧经 KS /list 过滤到当前实例（不泄露其它实例 URL）
 */
import type { Hono } from 'hono';
import type { PanelDeps } from '../../../panel-deps.js';
import { validatePanelMetaHeaders } from '../../middleware/validate-panel-headers.js';
import { respondControlError, respondEnvelope } from '../../envelope.js';
import { buildCtx, okEnvelope, readJson, requireCaller } from '../knowledge/common.js';
import {
  assessCompatibility,
  type ConnectionTestResult,
  type CompatibilityResult,
} from './logic.js';
import { runConnectionTest } from './llm-test.js';
import {
  ksListBindings,
  ksSetBinding,
  KsUpstreamError,
  type KsClientOpts,
} from './ks-binding-client.js';
import {
  compatibilityRequestSchema,
  knowledgeBindingSetSchema,
  testRequestSchema,
} from './schemas.js';

function hostOf(raw: string): string {
  try {
    return new URL(raw).host;
  } catch {
    return 'invalid';
  }
}

function ksOpts(deps: PanelDeps): KsClientOpts {
  return {
    baseUrl: deps.config.knowledge.baseUrl,
    authToken: deps.config.knowledge.authToken,
    timeoutMs: deps.config.knowledge.timeoutMs,
  };
}

function mapKsError(c: Parameters<typeof respondControlError>[0], err: unknown) {
  if (err instanceof KsUpstreamError) {
    const status = err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 502;
    return respondControlError(c, status, err.message);
  }
  return respondControlError(c, 502, 'UPSTREAM_ERROR');
}

export function registerLlmConfigRoutes(api: Hono, deps: PanelDeps): void {
  const mw = validatePanelMetaHeaders(deps);

  // ── 连接测试（面板进程内发请求，SSRF/超时/脱敏由 llm-test + safe-fetch 负责）──
  api.post('/llm-config/test', mw, async (c) => {
    const ctx = buildCtx(c);
    const caller = await requireCaller(deps, c, ctx);
    if ('error' in caller) return caller.error;

    const parsed = testRequestSchema.safeParse(await readJson(c));
    if (!parsed.success) return respondControlError(c, 400, 'INVALID_REQUEST');

    const req = parsed.data;
    deps.logger.info('llm-config connection test', { protocol: req.protocol, host: hostOf(req.base_url) });
    try {
      const result: ConnectionTestResult = await runConnectionTest(req);
      return respondEnvelope(c, okEnvelope(c, result));
    } catch (err) {
      deps.logger.error('llm-config connection test failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return respondControlError(c, 502, 'UPSTREAM_ERROR');
    }
  });

  // ── 兼容性评估（纯本地推演，无网络）──
  api.post('/llm-config/compatibility', mw, async (c) => {
    const ctx = buildCtx(c);
    const caller = await requireCaller(deps, c, ctx);
    if ('error' in caller) return caller.error;

    const parsed = compatibilityRequestSchema.safeParse(await readJson(c));
    if (!parsed.success) return respondControlError(c, 400, 'INVALID_REQUEST');

    const result: CompatibilityResult = assessCompatibility(parsed.data);
    return respondEnvelope(c, okEnvelope(c, result));
  });

  // ── Knowledge binding 读侧（KS /list 过滤到当前实例）──
  api.post('/llm-config/knowledge-binding/get', mw, async (c) => {
    const ctx = buildCtx(c);
    const caller = await requireCaller(deps, c, ctx);
    if ('error' in caller) return caller.error;

    try {
      const items = await ksListBindings(ksOpts(deps));
      const row = items.find((b) => b.service_id === ctx.instanceId) ?? null;
      return respondEnvelope(c, okEnvelope(c, {
        bound: !!row,
        mode: row?.mode ?? null,
        proxy_base_url: row?.proxy_base_url ?? null,
        base_url: row?.base_url ?? null,
        has_api_key: row?.has_api_key ?? false,
        enabled: row?.enabled ?? false,
      }));
    } catch (err) {
      deps.logger.error('llm-config knowledge-binding/get failed', {
        instanceId: ctx.instanceId,
        error: err instanceof Error ? err.message : String(err),
      });
      return mapKsError(c, err);
    }
  });

  // ── Knowledge binding 实时保存（KS /set；instanceId = 注册表实例 id）──
  api.post('/llm-config/knowledge-binding/set', mw, async (c) => {
    const ctx = buildCtx(c);
    const caller = await requireCaller(deps, c, ctx);
    if ('error' in caller) return caller.error;

    const parsed = knowledgeBindingSetSchema.safeParse(await readJson(c));
    if (!parsed.success) return respondControlError(c, 400, 'INVALID_REQUEST');
    const input = parsed.data;

    // 与 KS /set 前置校验一致，提前返回友好错误
    if (input.mode === 'proxy' && !input.proxy_base_url) {
      return respondControlError(c, 400, 'PROXY_BASE_URL_REQUIRED');
    }
    if (input.mode === 'byo' && !input.base_url) {
      return respondControlError(c, 400, 'BYO_BASE_URL_REQUIRED');
    }

    try {
      const result = await ksSetBinding(ksOpts(deps), ctx.instanceId, {
        mode: input.mode,
        proxy_base_url: input.proxy_base_url || undefined,
        base_url: input.base_url || undefined,
        api_key: input.api_key,
        enabled: input.enabled,
      });
      deps.logger.info('llm-config knowledge-binding/set ok', {
        instanceId: ctx.instanceId,
        mode: input.mode,
      });
      return respondEnvelope(c, okEnvelope(c, result));
    } catch (err) {
      deps.logger.error('llm-config knowledge-binding/set failed', {
        instanceId: ctx.instanceId,
        error: err instanceof Error ? err.message : String(err),
      });
      return mapKsError(c, err);
    }
  });
}