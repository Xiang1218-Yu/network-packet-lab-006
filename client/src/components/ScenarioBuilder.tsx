import { useEffect, useState, type ReactNode } from 'react';
import type {
  BuilderIssue,
  BuilderResult,
  HandshakeStage,
  HeaderInput,
  HttpBuilderInput,
  PacketScenario,
  Protocol,
  ScenarioTemplate,
  SimulatedPacket,
  TcpBuilderInput,
  TcpFlag
} from '../../../shared/types';
import { HANDSHAKE_PRESETS, TCP_FLAGS, utf8ByteLength } from '../../../shared/protocol';

const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:3001';

interface BuilderDraft {
  protocol: Protocol;
  scenario: PacketScenario;
  // HTTP request
  method: string;
  target: string;
  reqHost: string;
  reqPort: string;
  // HTTP response
  statusCode: string;
  reason: string;
  // HTTP common
  httpVersion: string;
  headers: HeaderInput[];
  body: string;
  // TCP
  sourceHost: string;
  sourcePort: string;
  destinationHost: string;
  destinationPort: string;
  flags: TcpFlag[];
  seq: string;
  ack: string;
  window: string;
  mss: string;
  windowScale: string;
  dataLength: string;
}

function defaultDraft(protocol: Protocol, scenario: PacketScenario): BuilderDraft {
  const base: BuilderDraft = {
    protocol,
    scenario,
    method: 'GET',
    target: '/api/devices?status=online',
    reqHost: 'lab.local',
    reqPort: '',
    statusCode: '200',
    reason: '',
    httpVersion: 'HTTP/1.1',
    headers: [
      { key: 'Accept', value: 'application/json' },
      { key: 'User-Agent', value: 'PacketLab/1.0' }
    ],
    body: '',
    sourceHost: '10.0.0.24',
    sourcePort: '51842',
    destinationHost: '10.0.0.8',
    destinationPort: '443',
    flags: [],
    seq: '0',
    ack: '0',
    window: '64240',
    mss: '1460',
    windowScale: '7',
    dataLength: ''
  };
  if (protocol === 'HTTP') {
    if (scenario === 'response') {
      base.headers = [{ key: 'Content-Type', value: 'application/json' }, { key: 'Content-Length', value: '' }];
      base.body = '{"devices":[{"id":"edge-01","status":"online"}]}';
    }
    return base;
  }
  // TCP defaults mirror the direction / handshake stage
  if (scenario === 'handshake') {
    Object.assign(base, HANDSHAKE_PRESETS.syn, { mss: '1460', windowScale: '7' });
    return base;
  }
  if (scenario === 'request') {
    base.flags = ['ACK', 'PSH'];
    base.seq = '18492031';
    base.ack = '77120102';
    base.dataLength = '128';
    base.mss = '';
    base.windowScale = '';
    return base;
  }
  // response: swap endpoints
  base.sourceHost = '10.0.0.8';
  base.sourcePort = '443';
  base.destinationHost = '10.0.0.24';
  base.destinationPort = '51842';
  base.flags = ['ACK', 'PSH'];
  base.seq = '77120102';
  base.ack = '18492159';
  base.window = '28960';
  base.dataLength = '512';
  base.mss = '';
  base.windowScale = '';
  return base;
}

function draftToInput(draft: BuilderDraft): HttpBuilderInput | TcpBuilderInput {
  if (draft.protocol === 'HTTP') {
    const common = {
      protocol: 'HTTP' as const,
      version: draft.httpVersion,
      headers: draft.headers,
      body: draft.body
    };
    if (draft.scenario === 'response') {
      return {
        ...common,
        scenario: 'response',
        statusCode: draft.statusCode,
        reason: draft.reason
      };
    }
    return {
      ...common,
      scenario: 'request',
      method: draft.method,
      target: draft.target,
      endpoint: { host: draft.reqHost, port: draft.reqPort.trim() === '' ? '' : Number(draft.reqPort) }
    };
  }
  return {
    protocol: 'TCP',
    scenario: draft.scenario as TcpBuilderInput['scenario'],
    source: { host: draft.sourceHost, port: Number(draft.sourcePort) },
    destination: { host: draft.destinationHost, port: Number(draft.destinationPort) },
    flags: draft.flags,
    seq: draft.seq,
    ack: draft.ack,
    window: draft.window,
    mss: draft.mss,
    windowScale: draft.windowScale,
    dataLength: draft.dataLength
  };
}

interface ScenarioBuilderProps {
  onApply: (packet: SimulatedPacket, raw: string, target: { protocol: Protocol; scenario: PacketScenario }) => void;
  onError: (message: string) => void;
}

interface GenerateResponse { data?: BuilderResult; issues?: BuilderIssue[]; error?: string }
interface TemplateListResponse { data: ScenarioTemplate[] }
interface TemplateSaveResponse { data?: ScenarioTemplate; issues?: BuilderIssue[]; error?: string }

async function postJson(path: string, body: unknown): Promise<Response> {
  return fetch(`${API_BASE}${path}`, {
    method: path.includes('/templates/') ? 'PUT' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

export function ScenarioBuilder({ onApply, onError }: ScenarioBuilderProps) {
  const [draft, setDraft] = useState<BuilderDraft>(() => defaultDraft('HTTP', 'request'));
  const [result, setResult] = useState<BuilderResult | null>(null);
  const [blockingIssues, setBlockingIssues] = useState<BuilderIssue[]>([]);
  const [busy, setBusy] = useState(false);
  const [templates, setTemplates] = useState<ScenarioTemplate[]>([]);
  const [templateName, setTemplateName] = useState('');
  const [savedHint, setSavedHint] = useState('');

  const patch = (changes: Partial<BuilderDraft>) => setDraft((current) => ({ ...current, ...changes }));

  const isHttp = draft.protocol === 'HTTP';
  const isRequest = draft.scenario === 'request';
  const isHandshake = draft.protocol === 'TCP' && draft.scenario === 'handshake';

  const loadTemplates = async () => {
    try {
      const response = await fetch(`${API_BASE}/api/templates`);
      if (response.ok) setTemplates((await response.json() as TemplateListResponse).data);
    } catch {
      /* template list is best-effort */
    }
  };

  useEffect(() => { void loadTemplates(); }, []);

  const changeProtocol = (protocol: Protocol) => {
    const scenario: PacketScenario = protocol === 'HTTP' ? 'request' : 'handshake';
    setDraft(defaultDraft(protocol, scenario));
    setResult(null);
    setBlockingIssues([]);
  };

  const changeScenario = (scenario: PacketScenario) => {
    setDraft(defaultDraft(draft.protocol, scenario));
    setResult(null);
    setBlockingIssues([]);
  };

  const applyHandshakePreset = (stage: HandshakeStage) => {
    const preset = HANDSHAKE_PRESETS[stage];
    patch({
      flags: [...preset.flags],
      seq: String(preset.seq),
      ack: String(preset.ack),
      dataLength: String(preset.dataLength),
      window: String(preset.window)
    });
  };

  const generate = async () => {
    setBusy(true);
    setBlockingIssues([]);
    setSavedHint('');
    try {
      const response = await postJson('/api/builder/generate', draftToInput(draft));
      const payload = await response.json() as GenerateResponse;
      if (!response.ok) {
        setResult(null);
        setBlockingIssues(payload.issues ?? []);
        if (!payload.issues?.length && payload.error) onError(payload.error);
        return;
      }
      if (payload.data) {
        setResult(payload.data);
        setBlockingIssues([]);
      }
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : '生成数据包失败');
    } finally {
      setBusy(false);
    }
  };

  const syncContentLength = () => {
    const byteLength = utf8ByteLength(draft.body);
    const nextHeaders = draft.headers.filter((header) => header.key.toLowerCase() !== 'content-length');
    nextHeaders.splice(1, 0, { key: 'Content-Length', value: String(byteLength) });
    patch({ headers: nextHeaders });
  };

  const updateHeader = (index: number, key: 'key' | 'value', value: string) => {
    patch({ headers: draft.headers.map((header, current) => (current === index ? { ...header, [key]: value } : header)) });
  };

  const addHeader = () => patch({ headers: [...draft.headers, { key: '', value: '' }] });
  const removeHeader = (index: number) => patch({ headers: draft.headers.filter((_, current) => current !== index) });

  const toggleFlag = (flag: TcpFlag) => {
    patch({ flags: draft.flags.includes(flag) ? draft.flags.filter((item) => item !== flag) : [...draft.flags, flag] });
  };

  const saveTemplate = async () => {
    if (!templateName.trim()) return;
    setBusy(true);
    try {
      const response = await postJson('/api/templates', { name: templateName, input: draftToInput(draft) });
      const payload = await response.json() as TemplateSaveResponse;
      if (!response.ok) {
        setBlockingIssues(payload.issues ?? []);
        if (payload.error) onError(payload.error);
        return;
      }
      setSavedHint(`已保存模板 ${payload.data?.id ?? ''}，内置样例不受影响。`);
      setTemplateName('');
      void loadTemplates();
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : '保存模板失败');
    } finally {
      setBusy(false);
    }
  };

  const deleteTemplateItem = async (id: string) => {
    try {
      const response = await fetch(`${API_BASE}/api/templates/${id}`, { method: 'DELETE' });
      if (response.ok) void loadTemplates();
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : '删除模板失败');
    }
  };

  const loadTemplate = (template: ScenarioTemplate) => {
    const input = template.input;
    const next = defaultDraft(input.protocol, input.scenario);
    if (input.protocol === 'HTTP') {
      if (input.scenario === 'request') {
        next.method = input.method ?? 'GET';
        next.target = input.target ?? '/';
        next.reqHost = input.endpoint?.host ?? '';
        next.reqPort = input.endpoint?.port !== undefined ? String(input.endpoint.port) : '';
      } else {
        next.statusCode = String(input.statusCode ?? '');
        next.reason = input.reason ?? '';
      }
      next.httpVersion = input.version ?? 'HTTP/1.1';
      next.headers = (input.headers ?? []).map((header) => ({ ...header }));
      next.body = input.body ?? '';
    } else {
      next.sourceHost = input.source.host;
      next.sourcePort = String(input.source.port);
      next.destinationHost = input.destination.host;
      next.destinationPort = String(input.destination.port);
      next.flags = (input.flags as TcpFlag[]) ?? [];
      next.seq = input.seq !== undefined ? String(input.seq) : '0';
      next.ack = input.ack !== undefined ? String(input.ack) : '0';
      next.window = input.window !== undefined ? String(input.window) : '64240';
      next.mss = input.mss !== undefined ? String(input.mss) : '';
      next.windowScale = input.windowScale !== undefined ? String(input.windowScale) : '';
      next.dataLength = input.dataLength !== undefined ? String(input.dataLength) : '';
    }
    setDraft(next);
    setResult(null);
    setBlockingIssues([]);
    setSavedHint(`已载入模板“${template.name}”，可继续编辑后重新生成。`);
  };

  const sendToInspector = () => {
    if (!result) return;
    onApply(result.packet, result.raw, { protocol: draft.protocol, scenario: draft.scenario });
  };

  const allIssues = [...blockingIssues, ...(result?.issues ?? [])];
  const errorCount = allIssues.filter((item) => item.level === 'error').length;
  const warningCount = allIssues.filter((item) => item.level === 'warning').length;

  return (
    <section className="builder-layout">
      <div className="panel builder-form-panel">
        <div className="panel-heading">
          <div>
            <p className="section-kicker">SCENARIO BUILDER / 结构化构建</p>
            <h3>场景构建器</h3>
          </div>
          <span className="badge">{draft.protocol} · {draft.scenario}</span>
        </div>

        <div className="builder-step">
          <p className="builder-step-title"><span>1</span> 协议与方向 <em className="required-hint">必选</em></p>
          <div className="builder-row">
            <div className="segmented-control">
              {(['HTTP', 'TCP'] as Protocol[]).map((item) => (
                <button key={item} type="button" className={draft.protocol === item ? 'active' : ''} onClick={() => changeProtocol(item)}>{item}</button>
              ))}
            </div>
            <div className="segmented-control">
              {(isHttp
                ? ([['request', 'HTTP 请求'], ['response', 'HTTP 响应']] as const)
                : ([['handshake', 'TCP 握手'], ['request', '数据 · 出站'], ['response', '数据 · 入站']] as const)
              ).map(([value, label]) => (
                <button key={value} type="button" className={draft.scenario === value ? 'active' : ''} onClick={() => changeScenario(value)}>{label}</button>
              ))}
            </div>
          </div>
          {isHandshake && (
            <div className="handshake-presets">
              <span className="optional-tag">握手阶段快捷填充（可选）</span>
              {([['syn', '① SYN'], ['syn-ack', '② SYN, ACK'], ['ack', '③ ACK']] as const).map(([stage, label]) => (
                <button key={stage} type="button" className="button ghost tiny" onClick={() => applyHandshakePreset(stage)}>{label}</button>
              ))}
            </div>
          )}
        </div>

        {isHttp ? (
          <>
            <div className="builder-step">
              <p className="builder-step-title"><span>2</span> {isRequest ? '请求行与端点' : '状态行'}</p>
              <div className="builder-grid">
                {isRequest ? (
                  <>
                    <Field label="请求方法 Method" required>
                      <input list="http-methods" value={draft.method} onChange={(event) => patch({ method: event.target.value })} />
                      <datalist id="http-methods">
                        {['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].map((method) => <option key={method} value={method} />)}
                      </datalist>
                    </Field>
                    <Field label="请求路径 / 目标 Target" required className="wide">
                      <input value={draft.target} onChange={(event) => patch({ target: event.target.value })} placeholder="/api/path?query=1" />
                    </Field>
                    <Field label="HTTP 版本" required>
                      <select value={draft.httpVersion} onChange={(event) => patch({ httpVersion: event.target.value })}>
                        <option value="HTTP/1.1">HTTP/1.1</option>
                        <option value="HTTP/1.0">HTTP/1.0</option>
                        <option value="HTTP/2.0">HTTP/2.0</option>
                      </select>
                    </Field>
                    <Field label="端点主机 Host" required>
                      <input value={draft.reqHost} onChange={(event) => patch({ reqHost: event.target.value })} placeholder="lab.local 或 10.0.0.8" />
                    </Field>
                    <Field label="端点端口" optionalHint="留空则 Host header 不带端口">
                      <input value={draft.reqPort} onChange={(event) => patch({ reqPort: event.target.value })} placeholder="80 / 443 …" />
                    </Field>
                  </>
                ) : (
                  <>
                    <Field label="HTTP 版本" required>
                      <select value={draft.httpVersion} onChange={(event) => patch({ httpVersion: event.target.value })}>
                        <option value="HTTP/1.1">HTTP/1.1</option>
                        <option value="HTTP/1.0">HTTP/1.0</option>
                        <option value="HTTP/2.0">HTTP/2.0</option>
                      </select>
                    </Field>
                    <Field label="状态码 Status" required>
                      <input value={draft.statusCode} onChange={(event) => patch({ statusCode: event.target.value })} placeholder="200 / 404 / 500 …" />
                    </Field>
                    <Field label="Reason Phrase" optionalHint="留空按状态码自动补全" className="wide">
                      <input value={draft.reason} onChange={(event) => patch({ reason: event.target.value })} placeholder="OK" />
                    </Field>
                  </>
                )}
              </div>
            </div>

            <div className="builder-step">
              <p className="builder-step-title">
                <span>3</span> Headers
                <span className="optional-tag">可选 · 每行一个</span>
                {!isRequest && (
                  <button type="button" className="link-button" onClick={syncContentLength}>按 body 字节数同步 Content-Length</button>
                )}
              </p>
              <div className="header-editor">
                {draft.headers.map((header, index) => (
                  <div className="header-row" key={index}>
                    <input aria-label="header 名称" value={header.key} placeholder="Header-Name" onChange={(event) => updateHeader(index, 'key', event.target.value)} />
                    <input aria-label="header 值" value={header.value} placeholder="value" onChange={(event) => updateHeader(index, 'value', event.target.value)} />
                    <button type="button" className="link-button danger" onClick={() => removeHeader(index)}>删除</button>
                  </div>
                ))}
                <button type="button" className="button ghost tiny" onClick={addHeader}>＋ 添加 header</button>
              </div>
            </div>

            <div className="builder-step">
              <p className="builder-step-title"><span>4</span> Body <span className="optional-tag">可选</span></p>
              <textarea className="builder-body" value={draft.body} onChange={(event) => patch({ body: event.target.value })} spellCheck={false} placeholder='{"hello":"world"} 或任意文本' />
            </div>
          </>
        ) : (
          <>
            <div className="builder-step">
              <p className="builder-step-title"><span>2</span> 端点（IP : 端口）<em className="required-hint">必填</em></p>
              <div className="builder-grid">
                <Field label="源地址 Source Host" required>
                  <input value={draft.sourceHost} onChange={(event) => patch({ sourceHost: event.target.value })} />
                </Field>
                <Field label="源端口" required>
                  <input value={draft.sourcePort} onChange={(event) => patch({ sourcePort: event.target.value })} />
                </Field>
                <Field label="目标地址 Destination Host" required>
                  <input value={draft.destinationHost} onChange={(event) => patch({ destinationHost: event.target.value })} />
                </Field>
                <Field label="目标端口" required>
                  <input value={draft.destinationPort} onChange={(event) => patch({ destinationPort: event.target.value })} />
                </Field>
              </div>
            </div>

            <div className="builder-step">
              <p className="builder-step-title"><span>3</span> TCP 控制字段 <em className="required-hint">Flags 必填</em></p>
              <div className="flag-picker">
                {TCP_FLAGS.map((flag) => (
                  <button
                    key={flag}
                    type="button"
                    className={`flag-chip ${draft.flags.includes(flag) ? 'active' : ''}`}
                    onClick={() => toggleFlag(flag)}
                  >{flag}</button>
                ))}
              </div>
              <div className="builder-grid four">
                <Field label="序列号 Seq"><input value={draft.seq} onChange={(event) => patch({ seq: event.target.value })} /></Field>
                <Field label="确认号 Ack"><input value={draft.ack} onChange={(event) => patch({ ack: event.target.value })} /></Field>
                <Field label="窗口 Win"><input value={draft.window} onChange={(event) => patch({ window: event.target.value })} /></Field>
                <Field label="数据长度 Len" optionalHint={isHandshake ? '握手应为 0' : '0 表示无 payload'}>
                  <input value={draft.dataLength} onChange={(event) => patch({ dataLength: event.target.value })} placeholder={isHandshake ? '0' : '128'} />
                </Field>
                <Field label="MSS" optionalHint="仅 SYN 报文">
                  <input value={draft.mss} onChange={(event) => patch({ mss: event.target.value })} />
                </Field>
                <Field label="窗口缩放 WS" optionalHint="仅 SYN 报文">
                  <input value={draft.windowScale} onChange={(event) => patch({ windowScale: event.target.value })} />
                </Field>
              </div>
            </div>
          </>
        )}

        <div className="builder-actions">
          <button type="button" className="button ghost" onClick={() => { setDraft(defaultDraft(draft.protocol, draft.scenario)); setResult(null); setBlockingIssues([]); }}>重置表单</button>
          <button type="button" className="button primary" onClick={() => void generate()} disabled={busy}>{busy ? '处理中…' : '生成 raw 数据包 →'}</button>
        </div>

        {allIssues.length > 0 && (
          <div className={`issue-panel ${errorCount ? 'has-errors' : ''}`}>
            <p className="issue-summary">
              {errorCount > 0 && <span className="issue-count error">{errorCount} 个冲突/错误</span>}
              {warningCount > 0 && <span className="issue-count warning">{warningCount} 个警告</span>}
            </p>
            <ul>
              {allIssues.map((item, index) => (
                <li key={`${item.level}-${item.field}-${index}`} className={`issue-item issue-${item.level}`}>
                  <span className="issue-level">{item.level === 'error' ? '冲突' : '提示'}</span>
                  <code className="issue-field">{item.field}</code>
                  <span>{item.message}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <div className="builder-side">
        <div className="panel builder-result-panel">
          <div className="panel-heading">
            <div>
              <p className="section-kicker">GENERATED RAW / 模拟格式输出</p>
              <h3>生成结果</h3>
            </div>
            {result && <span className="badge">{result.packet.metadata.length} BYTES</span>}
          </div>
          {result ? (
            <>
              <pre className="raw-preview">{result.raw}</pre>
              <p className="raw-note">文本以 CRLF（HTTP）/ 管道摘要（TCP）生成，可直接送入现有解析器。</p>
              <div className="builder-actions vertical">
                <button type="button" className="button primary" onClick={sendToInspector}>送入解析工作台 →</button>
              </div>
            </>
          ) : (
            <div className="empty-state">填写左侧字段后点击“生成”，符合当前模拟格式的 raw 文本将显示在这里。</div>
          )}
        </div>

        <div className="panel builder-templates-panel">
          <div className="panel-heading">
            <div>
              <p className="section-kicker">SAVED TEMPLATES / 场景模板</p>
              <h3>模板库</h3>
            </div>
            <span className="trace-id">{templates.length} SAVED</span>
          </div>
          <div className="template-save-row">
            <input
              value={templateName}
              onChange={(event) => setTemplateName(event.target.value)}
              placeholder="模板名称（唯一 ID 由服务端分配）"
              maxLength={64}
            />
            <button type="button" className="button ghost tiny" onClick={() => void saveTemplate()} disabled={busy || !templateName.trim()}>保存当前场景</button>
          </div>
          {savedHint && <p className="template-hint">✓ {savedHint}</p>}
          <ul className="template-list">
            {templates.length === 0 && <li className="empty-state compact">还没有保存过模板。模板存储在 data/scenario-templates.json，与内置样例完全隔离。</li>}
            {templates.map((template) => (
              <li key={template.id} className="template-item">
                <button type="button" className="template-main" onClick={() => loadTemplate(template)}>
                  <strong>{template.name}</strong>
                  <code>{template.id}</code>
                  <span>{template.protocol} · {template.scenario}</span>
                </button>
                <button type="button" className="link-button danger" onClick={() => void deleteTemplateItem(template.id)}>删除</button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

function Field({
  label,
  required,
  optionalHint,
  className,
  children
}: {
  label: string;
  required?: boolean;
  optionalHint?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <label className={`builder-field ${className ?? ''}`}>
      <span className="field-label">
        {label}
        {required && <em className="required-hint">必填</em>}
        {optionalHint && <span className="optional-tag">{optionalHint}</span>}
      </span>
      {children}
    </label>
  );
}
