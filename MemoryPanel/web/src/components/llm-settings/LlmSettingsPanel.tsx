/**
 * components/llm-settings/LlmSettingsPanel.tsx — LLM 配置面板（SettingsDialog 的 LLM Tab）。
 *
 * 三张卡：
 *   - Memory LLM：MEMORY_LLM_*（.env，重启生效）→ 连接测试 + 兼容性检查 + .env 片段
 *   - Proxy 上游：PROXY_UPSTREAM_*（.env，重启生效）→ 同上（协议仅影响测试）
 *   - Knowledge 绑定：KS llm-binding（实时生效）→ 读取/保存 + 连接测试
 *
 * 安全约定：api_key 仅存于组件 state（password 输入），从不写回面板后端、
 * 不落 localStorage；.env 片段中的密钥默认打码，需手动「显示密钥」。
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Alert,
  Button,
  Input,
  Segment,
  Select,
  Switch,
  Tag,
  Text,
} from 'tea-component';
import {
  llmConfigApi,
  type BindingMode,
  type CompatibilityResult,
  type ConnectionTestResult,
  type KnowledgeBindingView,
  type LlmProtocol,
} from '@/lib/teamApi';
import { tea } from '@/lib/tea-bridge';

type CardId = 'memory' | 'proxy' | 'knowledge';

interface LlmFields {
  baseUrl: string;
  apiKey: string;
  model: string;
  protocol: LlmProtocol;
}

const EMPTY_FIELDS: LlmFields = { baseUrl: '', apiKey: '', model: '', protocol: 'openai' };

const PROTOCOL_OPTIONS: Array<{ value: LlmProtocol; text: string }> = [
  { value: 'openai', text: 'OpenAI' },
  { value: 'anthropic', text: 'Anthropic' },
];

const EMPTY_RESULTS: Record<CardId, { test: ConnectionTestResult | null; compat: CompatibilityResult | null }> = {
  memory: { test: null, compat: null },
  proxy: { test: null, compat: null },
  knowledge: { test: null, compat: null },
};

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function maskKey(key: string): string {
  if (!key) return '<your-api-key>';
  if (key.length <= 8) return '****';
  return `${key.slice(0, 4)}****${key.slice(-4)}`;
}

// ── 通用展示块 ──

function CardShell({ titleKey, descKey, extra, children }: {
  titleKey: string;
  descKey: string;
  extra?: ReactNode;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div
      style={{
        border: '1px solid var(--tea-color-border-primary-default)',
        borderRadius: 6,
        padding: 16,
        marginBottom: 16,
        background: 'var(--tea-color-bg-primary-default)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 4 }}>
        <div style={{ minWidth: 0 }}>
          <Text style={{ fontWeight: 600 }}>{t(titleKey)}</Text>
          <Text theme="weak" style={{ display: 'block', fontSize: 12, marginTop: 2, maxWidth: 560 }}>
            {t(descKey)}
          </Text>
        </div>
        {extra}
      </div>
      {children}
    </div>
  );
}

function FieldRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 10 }}>
      <Text theme="label" style={{ width: 96, flexShrink: 0, textAlign: 'right', fontSize: 12 }}>{label}</Text>
      <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
    </div>
  );
}

const MONO_PRE_STYLE: React.CSSProperties = {
  margin: 0,
  padding: '8px 10px',
  fontSize: 12,
  lineHeight: 1.6,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  background: '#f2f4f8',
  border: '1px solid var(--tea-color-border-primary-default)',
  borderRadius: 4,
  overflowX: 'auto',
};

function EnvSnippetBlock({ lines, revealed, onToggleReveal }: {
  lines: string[];
  revealed: boolean;
  onToggleReveal: () => void;
}) {
  const { t } = useTranslation();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      tea.notify.success(t('settings.llm.copied'));
    } catch (e) {
      tea.notify.error(t('settings.notify.saveFailed', { msg: errMsg(e) }));
    }
  };
  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
        <Text theme="label" style={{ fontSize: 12 }}>{t('settings.llm.envSnippet')}</Text>
        <div style={{ display: 'flex', gap: 8 }}>
          <Button onClick={onToggleReveal}>{revealed ? t('settings.llm.hideKey') : t('settings.llm.revealKey')}</Button>
          <Button onClick={() => void copy()}>{t('settings.llm.copy')}</Button>
        </div>
      </div>
      <pre style={MONO_PRE_STYLE}>{lines.join('\n')}</pre>
    </div>
  );
}

function TestAlert({ result }: { result: ConnectionTestResult | null }) {
  if (!result) return null;
  if (result.ok) {
    return (
      <Alert type="success" style={{ marginTop: 12 }}>
        {`HTTP ${result.httpStatus} · ${result.message}`}
      </Alert>
    );
  }
  const extra = [...result.errors, ...result.warnings].filter((x) => x && x !== result.message);
  return (
    <Alert type="error" style={{ marginTop: 12 }}>
      <div>{result.message}</div>
      {extra.map((x) => (
        <div key={x} style={{ marginTop: 2 }}>{x}</div>
      ))}
      {result.endpoint && <div style={{ marginTop: 4, fontSize: 12, opacity: 0.75 }}>{result.endpoint}</div>}
    </Alert>
  );
}

function CompatBox({ result }: { result: CompatibilityResult | null }) {
  const { t } = useTranslation();
  if (!result) return null;
  return (
    <div style={{ marginTop: 12 }}>
      <Alert type={result.ok ? 'success' : 'warning'}>
        <div>
          {result.ok
            ? t('settings.llm.compat.ok')
            : `${t('settings.llm.compat.failed')} ${result.errors.join('; ')}`}
        </div>
        {result.warnings.map((w) => (
          <div key={w.code} style={{ marginTop: 2 }}>{w.message}</div>
        ))}
      </Alert>
      <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
        {result.restart_required && (
          <Tag theme="warning" variant="soft" size="sm">{t('settings.llm.restartRequired')}</Tag>
        )}
        {result.live_update && (
          <Tag theme="success" variant="soft" size="sm">{t('settings.llm.liveUpdate')}</Tag>
        )}
      </div>
    </div>
  );
}

// ── 主面板 ──

export function LlmSettingsPanel() {
  const { t } = useTranslation();

  const [fields, setFields] = useState<Record<CardId, LlmFields>>({
    memory: { ...EMPTY_FIELDS },
    proxy: { ...EMPTY_FIELDS },
    knowledge: { ...EMPTY_FIELDS },
  });
  const [results, setResults] = useState(EMPTY_RESULTS);
  const [busy, setBusy] = useState<Record<CardId, { test: boolean; compat: boolean }>>({
    memory: { test: false, compat: false },
    proxy: { test: false, compat: false },
    knowledge: { test: false, compat: false },
  });
  const [reveal, setReveal] = useState<Record<CardId, boolean>>({
    memory: false,
    proxy: false,
    knowledge: false,
  });

  // knowledge binding 专属状态
  const [kbMode, setKbMode] = useState<BindingMode>('proxy');
  const [kbEnabled, setKbEnabled] = useState(true);
  const [kbView, setKbView] = useState<KnowledgeBindingView | null>(null);
  const [kbLoading, setKbLoading] = useState(false);
  const [kbSaving, setKbSaving] = useState(false);

  const patch = useCallback((card: CardId, p: Partial<LlmFields>) => {
    setFields((prev) => ({ ...prev, [card]: { ...prev[card], ...p } }));
  }, []);

  const runTest = async (card: CardId) => {
    const f = fields[card];
    setBusy((prev) => ({ ...prev, [card]: { ...prev[card], test: true } }));
    setResults((prev) => ({ ...prev, [card]: { ...prev[card], test: null } }));
    try {
      const r = await llmConfigApi.test({
        protocol: f.protocol,
        base_url: f.baseUrl,
        api_key: f.apiKey,
        model: f.model || undefined,
      });
      setResults((prev) => ({ ...prev, [card]: { ...prev[card], test: r } }));
    } catch (e) {
      tea.notify.error(t('settings.notify.saveFailed', { msg: errMsg(e) }));
    } finally {
      setBusy((prev) => ({ ...prev, [card]: { ...prev[card], test: false } }));
    }
  };

  const runCompat = async (card: CardId) => {
    const f = fields[card];
    setBusy((prev) => ({ ...prev, [card]: { ...prev[card], compat: true } }));
    try {
      const r = await llmConfigApi.compatibility({
        target: card,
        base_url: f.baseUrl,
        api_key: f.apiKey,
        model: f.model,
        protocol: f.protocol,
        mode: card === 'knowledge' ? kbMode : undefined,
        proxy_base_url: card === 'knowledge' && kbMode === 'proxy' ? f.baseUrl : undefined,
        enabled: card === 'knowledge' ? kbEnabled : undefined,
      });
      setResults((prev) => ({ ...prev, [card]: { ...prev[card], compat: r } }));
    } catch (e) {
      tea.notify.error(t('settings.notify.saveFailed', { msg: errMsg(e) }));
    } finally {
      setBusy((prev) => ({ ...prev, [card]: { ...prev[card], compat: false } }));
    }
  };

  const loadBinding = useCallback(async () => {
    setKbLoading(true);
    try {
      const v = await llmConfigApi.getKnowledgeBinding();
      setKbView(v);
      setKbEnabled(v.bound ? v.enabled : true);
      if (v.bound && v.mode) {
        const mode: BindingMode = v.mode === 'byo' ? 'byo' : 'proxy';
        setKbMode(mode);
        const url = mode === 'proxy' ? (v.proxy_base_url ?? '') : (v.base_url ?? '');
        patch('knowledge', { baseUrl: url });
      }
    } catch (e) {
      tea.notify.error(t('settings.llm.kb.loadFailed', { msg: errMsg(e) }));
    } finally {
      setKbLoading(false);
    }
  }, [patch, t]);

  useEffect(() => {
    void loadBinding();
  }, [loadBinding]);

  const saveBinding = async () => {
    const f = fields.knowledge;
    setKbSaving(true);
    try {
      await llmConfigApi.setKnowledgeBinding({
        mode: kbMode,
        proxy_base_url: kbMode === 'proxy' ? f.baseUrl || undefined : undefined,
        base_url: kbMode === 'byo' ? f.baseUrl || undefined : undefined,
        api_key: f.apiKey || undefined,
        enabled: kbEnabled,
      });
      tea.notify.success(t('settings.llm.kb.saved'));
      await loadBinding();
    } catch (e) {
      tea.notify.error(t('settings.llm.kb.saveFailed', { msg: errMsg(e) }));
    } finally {
      setKbSaving(false);
    }
  };

  const snippetLines = (card: CardId): string[] | null => {
    if (card === 'knowledge') return null;
    const f = fields[card];
    // 显示密钥时输出原始值；否则打码
    const key = reveal[card] && f.apiKey ? f.apiKey : maskKey(f.apiKey);
    const base = f.baseUrl || '<base-url>';
    const model = f.model || '<model>';
    if (card === 'memory') {
      return [
        `MEMORY_LLM_BASE_URL=${base}`,
        `MEMORY_LLM_API_KEY=${key}`,
        `MEMORY_LLM_MODEL=${model}`,
        `MEMORY_LLM_PROTOCOL=${f.protocol}`,
      ];
    }
    return [
      `PROXY_UPSTREAM_URL=${base}`,
      `PROXY_UPSTREAM_API_KEY=${key}`,
      `PROXY_UPSTREAM_MODEL=${model}`,
    ];
  };

  const kbUrlLabel = kbMode === 'proxy' ? t('settings.llm.kb.proxyBaseUrl') : t('settings.llm.kb.byoBaseUrl');

  return (
    <div>
      <div style={{ paddingTop: 4, marginBottom: 16 }}>
        <Text theme="label" style={{ display: 'block', marginBottom: 8 }}>{t('settings.llm.title')}</Text>
        <Text theme="weak" style={{ display: 'block', fontSize: 12, maxWidth: 620 }}>{t('settings.llm.desc')}</Text>
      </div>

      {/* ── Memory LLM ── */}
      <CardShell titleKey="settings.llm.card.memory" descKey="settings.llm.card.memory.desc">
        <FieldRow label={t('settings.llm.baseUrl')}>
          <Input
            value={fields.memory.baseUrl}
            placeholder="https://api.openai.com"
            onChange={(v) => patch('memory', { baseUrl: v })}
          />
        </FieldRow>
        <FieldRow label={t('settings.llm.apiKey')}>
          <Input
            type="password"
            value={fields.memory.apiKey}
            placeholder="sk-…"
            onChange={(v) => patch('memory', { apiKey: v })}
          />
        </FieldRow>
        <FieldRow label={t('settings.llm.model')}>
          <Input
            value={fields.memory.model}
            placeholder="deepseek-v4-pro"
            onChange={(v) => patch('memory', { model: v })}
          />
        </FieldRow>
        <FieldRow label={t('settings.llm.protocol')}>
          <Select
            appearance="button"
            matchButtonWidth
            value={fields.memory.protocol}
            options={PROTOCOL_OPTIONS}
            onChange={(v) => patch('memory', { protocol: v as LlmProtocol })}
          />
        </FieldRow>
        <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
          <Button onClick={() => void runTest('memory')} loading={busy.memory.test}>
            {busy.memory.test ? t('settings.llm.testing') : t('settings.llm.testConnection')}
          </Button>
          <Button onClick={() => void runCompat('memory')} loading={busy.memory.compat}>
            {busy.memory.compat ? t('settings.llm.checking') : t('settings.llm.checkCompatibility')}
          </Button>
        </div>
        <TestAlert result={results.memory.test} />
        <CompatBox result={results.memory.compat} />
        <EnvSnippetBlock
          lines={snippetLines('memory') ?? []}
          revealed={reveal.memory}
          onToggleReveal={() => setReveal((prev) => ({ ...prev, memory: !prev.memory }))}
        />
      </CardShell>

      {/* ── Proxy Upstream ── */}
      <CardShell titleKey="settings.llm.card.proxy" descKey="settings.llm.card.proxy.desc">
        <Alert type="info" style={{ marginTop: 8, marginBottom: 4 }}>
          {t('settings.llm.proxyAdvisory')}
        </Alert>
        <FieldRow label={t('settings.llm.baseUrl')}>
          <Input
            value={fields.proxy.baseUrl}
            placeholder="http://host.docker.internal:11434"
            onChange={(v) => patch('proxy', { baseUrl: v })}
          />
        </FieldRow>
        <FieldRow label={t('settings.llm.apiKey')}>
          <Input
            type="password"
            value={fields.proxy.apiKey}
            placeholder="sk-…"
            onChange={(v) => patch('proxy', { apiKey: v })}
          />
        </FieldRow>
        <FieldRow label={t('settings.llm.model')}>
          <Input
            value={fields.proxy.model}
            placeholder="deepseek-v4-pro"
            onChange={(v) => patch('proxy', { model: v })}
          />
        </FieldRow>
        <FieldRow label={t('settings.llm.protocol')}>
          <Select
            appearance="button"
            matchButtonWidth
            value={fields.proxy.protocol}
            options={PROTOCOL_OPTIONS}
            onChange={(v) => patch('proxy', { protocol: v as LlmProtocol })}
          />
        </FieldRow>
        <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
          <Button onClick={() => void runTest('proxy')} loading={busy.proxy.test}>
            {busy.proxy.test ? t('settings.llm.testing') : t('settings.llm.testConnection')}
          </Button>
          <Button onClick={() => void runCompat('proxy')} loading={busy.proxy.compat}>
            {busy.proxy.compat ? t('settings.llm.checking') : t('settings.llm.checkCompatibility')}
          </Button>
        </div>
        <TestAlert result={results.proxy.test} />
        <CompatBox result={results.proxy.compat} />
        <EnvSnippetBlock
          lines={snippetLines('proxy') ?? []}
          revealed={reveal.proxy}
          onToggleReveal={() => setReveal((prev) => ({ ...prev, proxy: !prev.proxy }))}
        />
      </CardShell>

      {/* ── Knowledge Binding ── */}
      <CardShell
        titleKey="settings.llm.card.knowledge"
        descKey="settings.llm.card.knowledge.desc"
        extra={
          kbView?.bound ? (
            <Tag theme="success" variant="soft" size="sm">
              {kbView.has_api_key ? t('settings.llm.kb.hasKey') : t('settings.llm.kb.noKey')}
            </Tag>
          ) : (
            <Tag theme="default" variant="soft" size="sm">{t('settings.llm.kb.notBound')}</Tag>
          )
        }
      >
        <FieldRow label={t('settings.llm.kb.mode')}>
          <Segment
            value={kbMode}
            onChange={(v) => setKbMode(v as BindingMode)}
            options={([
              { value: 'proxy', text: t('settings.llm.kb.mode.proxy') },
              { value: 'byo', text: t('settings.llm.kb.mode.byo') },
            ])}
          />
        </FieldRow>
        <FieldRow label={kbUrlLabel}>
          <Input
            value={fields.knowledge.baseUrl}
            placeholder={kbMode === 'proxy' ? 'http://127.0.0.1:8096' : 'https://api.openai.com'}
            onChange={(v) => patch('knowledge', { baseUrl: v })}
          />
        </FieldRow>
        <FieldRow label={t('settings.llm.apiKey')}>
          <Input
            type="password"
            value={fields.knowledge.apiKey}
            placeholder="sk-…（留空 = 保留已存 Key）"
            onChange={(v) => patch('knowledge', { apiKey: v })}
          />
        </FieldRow>
        <Text theme="weak" style={{ display: 'block', fontSize: 12, marginTop: 6 }}>
          {t('settings.llm.kb.keyFirstSet')}
        </Text>
        <FieldRow label={t('settings.llm.kb.enabled')}>
          <Switch value={kbEnabled} onChange={(v) => setKbEnabled(v)} disabled={kbLoading} />
        </FieldRow>
        <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
          <Button onClick={() => void loadBinding()} loading={kbLoading}>
            {kbLoading ? t('settings.llm.kb.loading') : t('settings.llm.kb.load')}
          </Button>
          <Button type="primary" onClick={() => void saveBinding()} loading={kbSaving} disabled={kbLoading}>
            {kbSaving ? t('settings.llm.kb.saving') : t('settings.llm.kb.save')}
          </Button>
          <Button onClick={() => void runTest('knowledge')} loading={busy.knowledge.test}>
            {busy.knowledge.test ? t('settings.llm.testing') : t('settings.llm.testConnection')}
          </Button>
          <Button onClick={() => void runCompat('knowledge')} loading={busy.knowledge.compat}>
            {busy.knowledge.compat ? t('settings.llm.checking') : t('settings.llm.checkCompatibility')}
          </Button>
        </div>
        <TestAlert result={results.knowledge.test} />
        <CompatBox result={results.knowledge.compat} />
        <Alert type="info" style={{ marginTop: 12 }}>
          {t('settings.llm.kb.modelGlobal')}
        </Alert>
      </CardShell>
    </div>
  );
}