/**
 * llm-config/schemas.ts — zod 请求校验schema（BFF 入参白名单）。
 *
 * api_key 字段只出现在请求方向；响应绝不包含 api_key。
 */
import { z } from 'zod';

export const protocolSchema = z.enum(['openai', 'anthropic']);
export const targetSchema = z.enum(['memory', 'proxy', 'knowledge']);
export const bindingModeSchema = z.enum(['proxy', 'byo']);

/** 连接测试请求 — 通用（三张卡共用同一个 BFF 端点）。 */
export const testRequestSchema = z.object({
  protocol: protocolSchema,
  base_url: z.string().trim().min(1).max(2048),
  api_key: z.string().max(8192).optional().default(''),
  model: z.string().trim().max(512).optional(),
});

/** 兼容性评估请求 — 纯本地推演，不发网络请求。 */
export const compatibilityRequestSchema = z.object({
  target: targetSchema,
  base_url: z.string().trim().max(2048).optional().default(''),
  api_key: z.string().max(8192).optional().default(''),
  model: z.string().trim().max(512).optional().default(''),
  protocol: protocolSchema.optional(),
  mode: bindingModeSchema.optional(),
  proxy_base_url: z.string().trim().max(2048).optional().default(''),
  enabled: z.boolean().optional(),
});

/** Knowledge binding 实时保存 — 与 KS /set 契约对齐（MemoryKnowledge/src/routes/llm-binding.ts）。 */
export const knowledgeBindingSetSchema = z.object({
  mode: bindingModeSchema,
  proxy_base_url: z.string().trim().max(2048).optional().default(''),
  base_url: z.string().trim().max(2048).optional().default(''),
  // 空串/缺省 ⇒ 不放进 KS 请求体，KS 保留已存 key；首次创建必须显式传 key
  api_key: z.string().max(8192).optional(),
  enabled: z.boolean().optional(),
});

export type TestRequest = z.infer<typeof testRequestSchema>;
export type CompatibilityRequest = z.infer<typeof compatibilityRequestSchema>;
export type KnowledgeBindingSetRequest = z.infer<typeof knowledgeBindingSetSchema>;