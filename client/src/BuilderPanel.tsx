import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  BuilderConflict,
  BuilderInput,
  PacketScenario,
  Protocol,
  ScenarioTemplateSummary,
  SimulatedPacket
} from '../../shared/types';
import {
  buildScenario,
  createTemplate,
  deleteTemplate,
  getTemplate,
  listTemplates,
  updateTemplate,
  type BuiltScenario
} from './builderApi';

interface HeaderEntry { key: string; value: string; }

interface FormState {
  httpScenario: 'request' | 'response';
  tcpScenario: PacketScenario;
  tcpDirection: 'request' | 'response';
  method: string;
  target: string;
  httpVersion: string;
  status: string;
  reason: string;
  host: string;
  headers: HeaderEntry[];
  body: string;
  srcIp: string;
  srcPort: string;
  dstIp: string;
  dstPort: string;
  seq: string;
  ack: string;
  flags: string;
  window: string;
  mss: string;
  windowScale: string;
  payloadLength: string;
}

const DEFAULT_HEADERS_REQUEST: HeaderEntry[] = [
  { key: 'Accept', value: 'application/json' }
];
const DEFAULT_HEADERS_RESPONSE: HeaderEntry[] = [
  { key: 'Content-Type', value: 'application/json' }
];

function freshForm(): FormState {
  return {
    httpScenario: 'request',
    tcpScenario: 'handshake',
    tcpDirection: 'request',
    method: 'GET',
    target: '/api/example',
    httpVersion: 'HTTP/1.1',
    status: '200',
    reason: '',
    host: 'lab.local',
    headers: DEFAULT_HEADERS_REQUEST.map((entry) => ({ ...entry })),
    body: '',
    srcIp: '10.0.0.24',
    srcPort: '51842',
    dstIp: '10.0.0.8',
    dstPort: '443',
    seq: '0',
    ack: '0',
    flags: '',
    window: '64240',
    mss: '1460',
    windowScale: '7',
    payloadLength: ''
  };
}

function buildHttpInput(form: FormState): BuilderInput {
  const headers = form.headers.filter((entry) => entry.key.trim());
  if (form.httpScenario === 'request') {
    return {
      kind: 'http',
      scenario: 'request',
      request: { method: form.method, target: form.target, version: form.httpVersion },
      host: form.host,
      headers,
      body: form.body
    };
  }
  return {
    kind: 'http',
    scenario: 'response',
    response: { version: form.httpVersion, status: form.status, reason: form.reason },
    host: form.host,
    headers,
    body: form.body
  };
}

function buildTcpInput(form: FormState): BuilderInput {
  const endpoint = {
    sourceIp: form.srcIp,
    sourcePort: form.srcPort,
    destinationIp: form.dstIp,
    destinationPort: form.dstPort
  };
  if (form.tcpScenario === 'handshake') {
    return {
      kind: 'tcp',
      scenario: 'handshake',
      direction: form.tcpDirection,
      endpoint,
      seq: form.seq,
      ack: form.ack,
      flags: form.flags,
      window: form.window,
      mss: form.mss,
      windowScale: form.windowScale,
      payloadLength: form.payloadLength
    };
  }
  return {
    kind: 'tcp',
    scenario: form.tcpScenario,
    direction: form.tcpScenario,
    endpoint,
    seq: form.seq,
    ack: form.ack,
    flags: form.flags,
    window: form.window,
    payloadLength: form.payloadLength
  };
}

function formToInput(protocol: Protocol, form: FormState): BuilderInput {
  return protocol === 'HTTP' ? buildHttpInput(form) : buildTcpInput(form);
}

function applyInputToForm(input: BuilderInput, base: FormState): FormState {
  const next = { ...base, headers: base.headers.map((entry) => ({ ...entry })) };
  if (input.kind === 'http') {
    next.httpScenario = input.scenario;
    next.method = input.request?.method ?? 'GET';
    next.target = input.request?.target ?? '/';
    next.httpVersion = input.request?.version ?? input.response?.version ?? 'HTTP/1.1';
    next.status = String(input.response?.status ?? '200');
    next.reason = input.response?.reason ?? '';
    next.host = input.host ?? '';
    next.headers = (input.headers ?? []).map((entry) => ({ ...entry }));
    next.body = input.body ?? '';
    return next;
  }
  next.tcpScenario = input.scenario;
  next.tcpDirection = input.direction;
  next.srcIp = input.endpoint?.sourceIp ?? '';
  next.srcPort = String(input.endpoint?.sourcePort ?? '');
  next.dstIp = input.endpoint?.destinationIp ?? '';
  next.dstPort = String(input.endpoint?.destinationPort ?? '');
  next.seq = String(input.seq ?? '');
  next.ack = String(input.ack ?? '');
  next.flags = input.flags ?? '';
  next.window = String(input.window ?? '');
  if (input.scenario === 'handshake') {
    next.mss = String(input.mss ?? '');
    next.windowScale = String(input.windowScale ?? '');
  }
  next.payloadLength = String(input.payloadLength ?? '');
  return next;
}

interface BuilderPanelProps {
  onInspect: (packet: SimulatedPacket, raw: string) => void;
}

export function BuilderPanel({ onInspect }: BuilderPanelProps) {
  const [protocol, setProtocol] = useState<Protocol>('HTTP');
  const [form, setForm] = useState<FormState>(freshForm);
  const [built, setBuilt] = useState<BuiltScenario | null>(null);
  const [buildError, setBuildError] = useState('');
  const [syncLength, setSyncLength] = useState(true);
  const [templates, setTemplates] = useState<ScenarioTemplateSummary[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [templateName, setTemplateName] = useState('');
  const [templateBusy, setTemplateBusy] = useState(false);
  const [inspectHint, setInspectHint] = useState('');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const update = useCallback(<K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
  }, []);

  const refreshTemplates = useCallback(async () => {
    try {
      setTemplates(await listTemplates());
    } catch {
      /* template list is best-effort */
    }
  }, []);

  const runBuild = useCallback(async (currentProtocol: Protocol, currentForm: FormState, sync: boolean) => {
    try {
      const result = await buildScenario(formToInput(currentProtocol, currentForm), sync);
      setBuilt(result);
      setBuildError('');
    } catch (cause) {
      setBuildError(cause instanceof Error ? cause.message : '构建失败');
    }
  }, []);

  /* Live build: debounce on every structural edit. */
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => { void runBuild(protocol, form, syncLength); }, 300);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [protocol, form, syncLength, runBuild]);

  useEffect(() => { void refreshTemplates(); }, [refreshTemplates]);

  const conflictsByField = useMemo(() => {
    const map = new Map<string, BuilderConflict[]>();
    for (const conflictItem of built?.conflicts ?? []) {
      const list = map.get(conflictItem.field) ?? [];
      list.push(conflictItem);
      map.set(conflictItem.field, list);
    }
    return map;
  }, [built]);

  const errors = built?.conflicts.filter((item) => item.severity === 'error') ?? [];
  const warnings = built?.conflicts.filter((item) => item.severity === 'warning') ?? [];

  const switchProtocol = (next: Protocol) => {
    setProtocol(next);
    setEditingId(null);
  };

  const switchHttpScenario = (scenario: 'request' | 'response') => {
    setForm((current) => ({
      ...current,
      httpScenario: scenario,
      headers: scenario === 'request'
        ? DEFAULT_HEADERS_REQUEST.map((entry) => ({ ...entry }))
        : DEFAULT_HEADERS_RESPONSE.map((entry) => ({ ...entry })),
      body: ''
    }));
    setEditingId(null);
  };

  const switchTcpScenario = (scenario: PacketScenario) => {
    setForm((current) => ({
      ...current,
      tcpScenario: scenario,
      tcpDirection: scenario === 'handshake' ? 'request' : scenario,
      flags: '',
      payloadLength: scenario === 'handshake' ? '' : current.payloadLength || '128'
    }));
    setEditingId(null);
  };

  const sendToInspector = () => {
    if (!built) return;
    onInspect(built.packet, built.raw);
    setInspectHint('已送入解析工作台，可切换到「解析工作台」标签查看。');
    setTimeout(() => setInspectHint(''), 3200);
  };

  const saveTemplate = async () => {
    if (!built || templateBusy) return;
    setTemplateBusy(true);
    try {
      const input = formToInput(protocol, form);
      if (editingId) {
        await updateTemplate(editingId, templateName, input);
      } else {
        const saved = await createTemplate(templateName, input);
        setEditingId(saved.id);
      }
      await refreshTemplates();
    } catch (cause) {
      setBuildError(cause instanceof Error ? cause.message : '模板保存失败');
    } finally {
      setTemplateBusy(false);
    }
  };

  const loadTemplate = async (id: string) => {
    try {
      const template = await getTemplate(id);
      setProtocol(template.protocol);
      setForm((current) => applyInputToForm(template.input, freshForm()));
      setEditingId(template.id);
      setTemplateName(template.name);
      void runBuild(template.protocol, applyInputToForm(template.input, freshForm()), syncLength);
    } catch (cause) {
      setBuildError(cause instanceof Error ? cause.message : '模板载入失败');
    }
  };

  const removeTemplate = async (id: string) => {
    try {
      await deleteTemplate(id);
      if (editingId === id) setEditingId(null);
      await refreshTemplates();
    } catch (cause) {
      setBuildError(cause instanceof Error ? cause.message : '模板删除失败');
    }
  };

  const isTcpHandshake = protocol === 'TCP' && form.tcpScenario === 'handshake';
  const conflictOf = (fieldPath: string) => conflictsByField.get(fieldPath);

  return (
    <div className="builder-layout">
      <div className="panel builder-form-panel">
        <div className="panel-heading">
          <div>
            <p className="section-kicker">SCENARIO BUILDER / 结构化构建</p>
            <h3>场景构建器</h3>
          </div>
          <span className={`validity-chip ${built?.valid ? 'ok' : 'bad'}`}>
            {built ? (built.valid ? '✓ 无阻断冲突' : `${errors.length} 个错误`) : '构建中…'}
          </span>
        </div>

        <div className="builder-section">
          <p className="builder-section-title">① 协议与场景</p>
          <div className="builder-row">
            <div className="segmented-control">
              {(['HTTP', 'TCP'] as Protocol[]).map((item) => (
                <button key={item} className={protocol === item ? 'active' : ''} onClick={() => switchProtocol(item)}>{item}</button>
              ))}
            </div>
            {protocol === 'HTTP' ? (
              <div className="segmented-control">
                {(['request', 'response'] as const).map((item) => (
                  <button key={item} className={form.httpScenario === item ? 'active' : ''} onClick={() => switchHttpScenario(item)}>
                    {item === 'request' ? 'HTTP 请求' : 'HTTP 响应'}
                  </button>
                ))}
              </div>
            ) : (
              <div className="segmented-control tcp-scenario-control">
                <button className={form.tcpScenario === 'handshake' ? 'active' : ''} onClick={() => switchTcpScenario('handshake')}>TCP 握手</button>
                <button className={form.tcpScenario === 'request' ? 'active' : ''} onClick={() => switchTcpScenario('request')}>数据 · 客户端→服务端</button>
                <button className={form.tcpScenario === 'response' ? 'active' : ''} onClick={() => switchTcpScenario('response')}>数据 · 服务端→客户端</button>
              </div>
            )}
          </div>
          {protocol === 'TCP' && form.tcpScenario === 'handshake' && (
            <div className="builder-row">
              <div className="segmented-control">
                <button className={form.tcpDirection === 'request' ? 'active' : ''} onClick={() => update('tcpDirection', 'request')}>方向：客户端 → 服务端（SYN）</button>
                <button className={form.tcpDirection === 'response' ? 'active' : ''} onClick={() => update('tcpDirection', 'response')}>方向：服务端 → 客户端（SYN-ACK）</button>
              </div>
            </div>
          )}
        </div>

        {protocol === 'HTTP' ? (
          <>
            <div className="builder-section">
              <p className="builder-section-title">② {form.httpScenario === 'request' ? '请求行 Request-Line' : '状态行 Status-Line'}</p>
              {form.httpScenario === 'request' ? (
                <div className="builder-grid three">
                  <Field label="方法 Method" required conflict={conflictOf('request.method')?.[0]}>
                    <input value={form.method} onChange={(event) => update('method', event.target.value)} placeholder="GET" />
                  </Field>
                  <Field label="请求目标 Target" required conflict={conflictOf('request.target')?.[0]}>
                    <input value={form.target} onChange={(event) => update('target', event.target.value)} placeholder="/api/path" />
                  </Field>
                  <Field label="版本 Version" optional conflict={undefined}>
                    <input value={form.httpVersion} onChange={(event) => update('httpVersion', event.target.value)} placeholder="HTTP/1.1" />
                  </Field>
                </div>
              ) : (
                <div className="builder-grid three">
                  <Field label="版本 Version" optional>
                    <input value={form.httpVersion} onChange={(event) => update('httpVersion', event.target.value)} placeholder="HTTP/1.1" />
                  </Field>
                  <Field label="状态码 Status" required conflict={conflictOf('response.status')?.[0]}>
                    <input value={form.status} onChange={(event) => update('status', event.target.value)} placeholder="200" inputMode="numeric" />
                  </Field>
                  <Field label="原因短语 Reason" optional hint="留空时按状态码自动补全">
                    <input value={form.reason} onChange={(event) => update('reason', event.target.value)} placeholder="OK" />
                  </Field>
                </div>
              )}
            </div>

            <div className="builder-section">
              <p className="builder-section-title">③ 端点与 Header</p>
              <div className="builder-grid">
                <Field
                  label={form.httpScenario === 'request' ? '端点主机 Host（必填）' : '端点主机 Host（可选）'}
                  required={form.httpScenario === 'request'}
                  optional={form.httpScenario === 'response'}
                  conflict={conflictOf('host')?.[0]}
                >
                  <input value={form.host} onChange={(event) => update('host', event.target.value)} placeholder="lab.local" />
                </Field>
              </div>
              <HeaderEditor headers={form.headers} conflict={conflictOf('headers')} onChange={(headers) => update('headers', headers)} />
              <label className="sync-toggle">
                <input type="checkbox" checked={syncLength} onChange={(event) => setSyncLength(event.target.checked)} />
                自动同步 Content-Length（取消勾选可保留错误值，用于演示冲突）
              </label>
            </div>

            <div className="builder-section">
              <p className="builder-section-title">④ Body <span className="optional-tag">可选</span></p>
              <Field label="" conflict={conflictOf('response.body')?.[0]} bare>
                <textarea className="builder-body" value={form.body} onChange={(event) => update('body', event.target.value)} placeholder='{"ok":true}' spellCheck={false} />
              </Field>
            </div>
          </>
        ) : (
          <>
            <div className="builder-section">
              <p className="builder-section-title">② 端点 Endpoint</p>
              <div className="builder-grid four">
                <Field label="源 IP" required conflict={conflictOf('endpoint.sourceIp')?.[0]}>
                  <input value={form.srcIp} onChange={(event) => update('srcIp', event.target.value)} placeholder="10.0.0.24" />
                </Field>
                <Field label="源端口" required conflict={conflictOf('endpoint.sourcePort')?.[0]}>
                  <input value={form.srcPort} onChange={(event) => update('srcPort', event.target.value)} placeholder="51842" inputMode="numeric" />
                </Field>
                <Field label="目标 IP" required conflict={conflictOf('endpoint.destinationIp')?.[0]}>
                  <input value={form.dstIp} onChange={(event) => update('dstIp', event.target.value)} placeholder="10.0.0.8" />
                </Field>
                <Field label="目标端口" required conflict={conflictOf('endpoint.destinationPort')?.[0]}>
                  <input value={form.dstPort} onChange={(event) => update('dstPort', event.target.value)} placeholder="443" inputMode="numeric" />
                </Field>
              </div>
            </div>

            <div className="builder-section">
              <p className="builder-section-title">③ TCP 控制字段</p>
              <div className="builder-grid four">
                <Field label="序列号 Seq" required conflict={conflictOf('tcp.seq')?.[0]}>
                  <input value={form.seq} onChange={(event) => update('seq', event.target.value)} inputMode="numeric" placeholder="0" />
                </Field>
                <Field label="确认号 Ack" required conflict={conflictOf('tcp.ack')?.[0]}>
                  <input value={form.ack} onChange={(event) => update('ack', event.target.value)} inputMode="numeric" placeholder="0" />
                </Field>
                <Field label="标志 Flags" required conflict={conflictOf('tcp.flags')?.[0]} hint="SYN/ACK/FIN/RST/PSH/URG，逗号分隔">
                  <input value={form.flags} onChange={(event) => update('flags', event.target.value)} placeholder={isTcpHandshake ? 'SYN' : 'ACK,PSH'} />
                </Field>
                <Field label="窗口 Win" optional conflict={conflictOf('tcp.window')?.[0]}>
                  <input value={form.window} onChange={(event) => update('window', event.target.value)} inputMode="numeric" placeholder="64240" />
                </Field>
              </div>
              {isTcpHandshake && (
                <div className="builder-grid four">
                  <Field label="MSS（可选）" optional conflict={conflictOf('tcp.mss')?.[0]}>
                    <input value={form.mss} onChange={(event) => update('mss', event.target.value)} inputMode="numeric" placeholder="1460" />
                  </Field>
                  <Field label="窗口缩放 WS（可选）" optional conflict={conflictOf('tcp.windowScale')?.[0]}>
                    <input value={form.windowScale} onChange={(event) => update('windowScale', event.target.value)} inputMode="numeric" placeholder="7" />
                  </Field>
                </div>
              )}
              <div className="builder-grid four">
                <Field
                  label={isTcpHandshake ? '数据长度 Len（握手应为 0）' : '数据长度 Len'}
                  required={!isTcpHandshake}
                  optional={isTcpHandshake}
                  conflict={conflictOf('tcp.payloadLength')?.[0]}
                >
                  <input value={form.payloadLength} onChange={(event) => update('payloadLength', event.target.value)} inputMode="numeric" placeholder={isTcpHandshake ? '0' : '128'} />
                </Field>
              </div>
            </div>
          </>
        )}
      </div>

      <div className="builder-side">
        {buildError && <div className="error-banner">⚠ {buildError}</div>}
        <div className="panel builder-result-panel">
          <div className="panel-heading"><div><p className="section-kicker">GENERATED RAW / 实时生成</p><h3>符合当前模拟格式的 raw 文本</h3></div></div>
          {built && (
            <>
              <div className="conflict-list">
                {errors.length === 0 && warnings.length === 0 && <p className="conflict-ok">✓ 字段之间没有冲突</p>}
                {errors.map((item) => <p key={`${item.field}-${item.code}`} className="conflict-item error"><b>错误</b> <code>{item.field}</code> · {item.message}</p>)}
                {warnings.map((item) => <p key={`${item.field}-${item.code}`} className="conflict-item warning"><b>警告</b> <code>{item.field}</code> · {item.message}</p>)}
              </div>
              <pre className="raw-preview">{renderRaw(built.raw)}</pre>
              <div className="raw-meta">
                <span>{built.packet.metadata.length} bytes · checksum {built.packet.metadata.checksum}</span>
                <span className="crlf-hint">CRLF 行尾</span>
              </div>
              <div className="builder-actions">
                <button className="button primary" onClick={sendToInspector}>送入解析工作台 →</button>
                <button className="button ghost" onClick={() => void runBuild(protocol, form, syncLength)}>↻ 重新生成</button>
              </div>
              {inspectHint && <p className="inspect-hint">{inspectHint}</p>}
            </>
          )}
        </div>

        <div className="panel builder-templates-panel">
          <div className="panel-heading"><div><p className="section-kicker">SAVED TEMPLATES / 场景模板</p><h3>我的模板（{templates.length}）</h3></div></div>
          <p className="templates-note">模板拥有独立唯一标识（tpl-…），保存在服务端 data 目录，与内置样例完全隔离。</p>
          <div className="template-save-row">
            <input
              value={templateName}
              onChange={(event) => setTemplateName(event.target.value)}
              placeholder={editingId ? '更新当前模板名称（可选）' : '模板名称，例如：课堂-500异常响应'}
            />
            <button className="button primary" disabled={templateBusy} onClick={() => void saveTemplate()}>
              {editingId ? (templateBusy ? '更新中…' : '更新模板') : (templateBusy ? '保存中…' : '保存为模板')}
            </button>
          </div>
          {editingId && <p className="editing-hint">正在编辑模板 <code>{editingId.slice(0, 22)}…</code>（保存将更新该模板，不会新建）</p>}
          <div className="template-list">
            {templates.length === 0 && <div className="empty-state">还没有保存任何场景模板。</div>}
            {templates.map((template) => (
              <div key={template.id} className={`template-item ${editingId === template.id ? 'active' : ''}`}>
                <div className="template-info">
                  <strong>{template.name}</strong>
                  <span>
                    <em>{template.protocol}</em> · {scenarioText(template.protocol, template.scenario)}
                    {!template.valid && <b className="tpl-bad"> {template.conflictCount} 冲突</b>}
                    {template.valid && template.conflictCount > 0 && <b className="tpl-warn"> {template.conflictCount} 警告</b>}
                  </span>
                  <code className="template-id">{template.id}</code>
                </div>
                <div className="template-ops">
                  <button className="button ghost small" onClick={() => void loadTemplate(template.id)}>载入</button>
                  <button className="button ghost small danger" onClick={() => void removeTemplate(template.id)}>删除</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function scenarioText(protocol: Protocol, scenario: PacketScenario): string {
  if (protocol === 'HTTP') return scenario === 'request' ? 'HTTP 请求' : 'HTTP 响应';
  if (scenario === 'handshake') return 'TCP 握手';
  return scenario === 'request' ? '数据 客户端→服务端' : '数据 服务端→客户端';
}

function renderRaw(raw: string): string {
  return raw.split('\r\n').map((line, index, array) => (index < array.length - 1 ? `${line} ␍␊` : line)).join('\n');
}

/* ------------------------------------------------------------------ */

interface FieldProps {
  label: string;
  required?: boolean;
  optional?: boolean;
  hint?: string;
  conflict?: BuilderConflict;
  bare?: boolean;
  children: React.ReactNode;
}

function Field({ label, required, optional, hint, conflict, bare, children }: FieldProps) {
  if (bare) return <div className={`field-wrap ${conflict ? 'has-conflict' : ''}`}>{children}{conflict && <p className="field-conflict">{conflict.message}</p>}</div>;
  return (
    <label className={`field-wrap ${conflict ? 'has-conflict' : ''}`}>
      <span className="field-label">
        {label}
        {required && <i className="required-mark">必填</i>}
        {optional && <i className="optional-mark">可选</i>}
      </span>
      {children}
      {hint && <small className="field-hint">{hint}</small>}
      {conflict && <p className="field-conflict">{conflict.message}</p>}
    </label>
  );
}

function HeaderEditor({ headers, conflict, onChange }: {
  headers: HeaderEntry[];
  conflict?: BuilderConflict[];
  onChange: (headers: HeaderEntry[]) => void;
}) {
  const setRow = (index: number, patch: Partial<HeaderEntry>) => {
    onChange(headers.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)));
  };
  return (
    <div className={`header-editor ${conflict?.length ? 'has-conflict-block' : ''}`}>
      <div className="header-editor-head">
        <span>Headers（可选，留空名称的行会被忽略）</span>
        <button type="button" className="button ghost small" onClick={() => onChange([...headers, { key: '', value: '' }])}>+ 添加 Header</button>
      </div>
      {conflict?.map((item) => <p key={item.code} className={`field-conflict ${item.severity}`}>{item.message}</p>)}
      {headers.map((entry, index) => (
        <div className="header-row" key={index}>
          <input value={entry.key} onChange={(event) => setRow(index, { key: event.target.value })} placeholder="Header-Name" />
          <input value={entry.value} onChange={(event) => setRow(index, { value: event.target.value })} placeholder="value" />
          <button type="button" className="header-remove" onClick={() => onChange(headers.filter((_, i) => i !== index))}>×</button>
        </div>
      ))}
    </div>
  );
}
