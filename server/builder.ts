import type {
  BuilderConflict,
  BuilderInput,
  HttpBuilderInput,
  PacketScenario,
  Protocol,
  SimulatedPacket,
  TcpDataInput,
  TcpDirection,
  TcpHandshakeInput
} from '../shared/types.js';
import { buildPacket } from './packets.js';

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

export type FieldErrors = Record<string, string>;

interface FieldConflict {
  field: string;
  code: string;
  message: string;
  severity: 'error' | 'warning';
}

function conflict(field: string, code: string, message: string, severity: 'error' | 'warning' = 'error'): FieldConflict {
  return { field, code, message, severity };
}

function asText(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

/** Parse a non-negative integer. Returns undefined for blank, null for invalid. */
function nonNegativeInt(value: unknown): number | undefined | null {
  const text = asText(value);
  if (!text) return undefined;
  if (!/^\d+$/.test(text)) return null;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

const IPV4 = /^(\d{1,3}\.){3}\d{1,3}$/;
const HTTP_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

function isValidIpv4(value: string): boolean {
  if (!IPV4.test(value)) return false;
  return value.split('.').every((part) => Number(part) <= 255);
}

function isValidPort(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 65535;
}

const KNOWN_TCP_FLAGS = new Set(['SYN', 'ACK', 'FIN', 'RST', 'PSH', 'URG']);

function normalizeFlags(value: string): string[] {
  return value
    .split(/[,\s|]+/)
    .map((part) => part.trim().toUpperCase())
    .filter(Boolean);
}

const DEFAULT_STATUS_REASONS: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  204: 'No Content',
  301: 'Moved Permanently',
  302: 'Found',
  304: 'Not Modified',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable'
};

/* ------------------------------------------------------------------ */
/* HTTP builder                                                        */
/* ------------------------------------------------------------------ */

interface HttpResult {
  raw: string;
  scenario: 'request' | 'response';
  conflicts: FieldConflict[];
}

function buildHttp(input: HttpBuilderInput, syncContentLength: boolean): HttpResult {
  const isResponse = input.scenario === 'response';
  const conflicts: FieldConflict[] = [];
  const errors: FieldErrors = {};

  const version = asText(input.response?.version) || asText(input.request?.version) || 'HTTP/1.1';

  /* ----- request line / status line ----- */
  let startLine: string;
  if (isResponse) {
    const statusText = asText(input.response?.status);
    if (!statusText) {
      errors['response.status'] = '响应状态码为必填项';
    }
    const status = Number(statusText);
    if (statusText && (!Number.isInteger(status) || status < 100 || status > 599)) {
      errors['response.status'] = '状态码必须是 100–599 之间的整数';
    }
    const reason = asText(input.response?.reason) || DEFAULT_STATUS_REASONS[status] || '';
    startLine = `${version} ${statusText || '000'}${reason ? ` ${reason}` : ''}`;
  } else {
    const method = asText(input.request?.method) || 'GET';
    if (asText(input.request?.method) && !HTTP_TOKEN.test(asText(input.request?.method))) {
      conflicts.push(conflict('request.method', 'http-invalid-method', `方法 "${asText(input.request?.method)}" 包含非法字符`, 'error'));
    }
    const target = asText(input.request?.target) || '/';
    if (asText(input.request?.target) && !target.startsWith('/')) {
      conflicts.push(conflict('request.target', 'http-target-form', '请求目标通常应以 "/" 开头（origin-form）', 'warning'));
    }
    startLine = `${method.toUpperCase()} ${target} ${version}`;
  }

  /* ----- headers ----- */
  const headerList = (input.headers ?? [])
    .map((entry) => ({ key: String(entry?.key ?? '').trim(), value: String(entry?.value ?? '').trim() }))
    .filter((entry) => entry.key.length > 0);

  const seenHeaderKeys = new Map<string, number>();
  for (const entry of headerList) {
    const lower = entry.key.toLowerCase();
    seenHeaderKeys.set(lower, (seenHeaderKeys.get(lower) ?? 0) + 1);
    if (!HTTP_TOKEN.test(entry.key)) {
      conflicts.push(conflict('headers', 'http-invalid-header-name', `Header 名称 "${entry.key}" 含有非法字符`, 'error'));
    }
  }
  for (const [lower, count] of seenHeaderKeys) {
    if (count > 1) {
      conflicts.push(conflict('headers', 'http-duplicate-header', `Header "${lower}" 出现了 ${count} 次，可能导致解析歧义`, 'warning'));
    }
  }

  const body = input.body ?? '';
  const bodyLength = Buffer.byteLength(body, 'utf8');
  const hasContentLength = seenHeaderKeys.has('content-length');
  const contentLengthValue = headerList.find((entry) => entry.key.toLowerCase() === 'content-length')?.value;

  if (hasContentLength) {
    const declared = Number(contentLengthValue);
    if (!/^\d+$/.test(asText(contentLengthValue)) || !Number.isInteger(declared)) {
      if (syncContentLength) {
        conflicts.push(conflict('headers', 'http-content-length-invalid', `Content-Length "${asText(contentLengthValue)}" 非法，已按实际 body（${bodyLength} 字节）自动修正`, 'warning'));
      } else {
        conflicts.push(conflict('headers', 'http-content-length-invalid', 'Content-Length 必须是非负整数', 'error'));
      }
    } else if (declared !== bodyLength) {
      if (syncContentLength) {
        conflicts.push(conflict(
          'headers',
          'http-content-length-auto-fixed',
          `Content-Length（${declared}）与实际 body（${bodyLength} 字节）不一致，已自动修正为 ${bodyLength}`,
          'warning'
        ));
      } else {
        conflicts.push(conflict(
          'headers',
          'http-content-length-mismatch',
          `Content-Length（${declared}）与实际 body 字节数（${bodyLength}）不一致`,
          'error'
        ));
      }
    }
  }

  const host = asText(input.host);
  const hasHost = seenHeaderKeys.has('host');
  if (!isResponse) {
    if (version.toUpperCase() === 'HTTP/1.1' && !host && !hasHost) {
      conflicts.push(conflict('host', 'http-missing-host', 'HTTP/1.1 请求必须携带 Host（端点主机）', 'error'));
    }
  }
  if (host && hasHost) {
    const headerHost = headerList.find((entry) => entry.key.toLowerCase() === 'host')?.value ?? '';
    if (headerHost && headerHost !== host) {
      conflicts.push(conflict('host', 'http-host-mismatch', `端点主机 "${host}" 与 Host header "${headerHost}" 不一致`, 'warning'));
    }
  }

  /* ----- render (apply optional Host / Content-Length auto-fix first) ----- */
  const rendered = headerList.map((entry) => `${entry.key}: ${entry.value}`);
  if (host && !hasHost) rendered.unshift(`Host: ${host}`);
  const willSyncLength = syncContentLength && (hasContentLength || bodyLength > 0);
  if (syncContentLength) {
    const index = rendered.findIndex((line) => line.toLowerCase().startsWith('content-length:'));
    const line = `Content-Length: ${bodyLength}`;
    if (index > -1) rendered[index] = line;
    else if (bodyLength > 0 || hasContentLength) rendered.push(line);
  }
  const effectiveHasLength = hasContentLength || willSyncLength;

  /* "Missing" conflicts are judged on the final rendered message so that an
     auto-synced Content-Length does not both fix the input and warn about it. */
  if (isResponse && !effectiveHasLength && bodyLength > 0) {
    conflicts.push(conflict('headers', 'http-missing-content-length', '响应带有 body 但未提供 Content-Length，课堂演示的简单解析器无法界定长度', 'warning'));
  }
  if (isResponse) {
    const status = Number(asText(input.response?.status));
    if ((status === 204 || status === 304) && bodyLength > 0) {
      conflicts.push(conflict('response.body', 'http-body-not-allowed', `${status} 响应按 RFC 不应携带 message body（当前 ${bodyLength} 字节）`, 'warning'));
    }
  }
  if (!isResponse && bodyLength > 0 && !effectiveHasLength) {
    conflicts.push(conflict('headers', 'http-request-no-length', '请求携带 body 但缺少 Content-Length（也未使用 Transfer-Encoding）', 'warning'));
  }

  const raw = `${startLine}\r\n${rendered.join('\r\n')}${rendered.length ? '\r\n' : ''}\r\n${body}`;
  return {
    raw,
    scenario: input.scenario,
    conflicts: [...Object.entries(errors).map(([fieldName, message]) => conflict(fieldName, 'field-required', message, 'error')), ...conflicts]
  };
}

/* ------------------------------------------------------------------ */
/* TCP builder                                                         */
/* ------------------------------------------------------------------ */

interface TcpEndpoint {
  source: string;
  destination: string;
}

function resolveTcpEndpoint(
  endpoint: { sourceIp?: unknown; sourcePort?: unknown; destinationIp?: unknown; destinationPort?: unknown },
  direction: TcpDirection,
  errors: FieldErrors
): TcpEndpoint | null {
  const defaults = direction === 'request'
    ? { sourceIp: '10.0.0.24', sourcePort: 51842, destinationIp: '10.0.0.8', destinationPort: 443 }
    : { sourceIp: '10.0.0.8', sourcePort: 443, destinationIp: '10.0.0.24', destinationPort: 51842 };

  const sourceIpText = asText(endpoint.sourceIp);
  const destinationIpText = asText(endpoint.destinationIp);
  const sourcePort = nonNegativeInt(endpoint.sourcePort);
  const destinationPort = nonNegativeInt(endpoint.destinationPort);

  if (sourceIpText && !isValidIpv4(sourceIpText)) errors['endpoint.sourceIp'] = '源 IP 需要是合法的 IPv4 地址';
  if (destinationIpText && !isValidIpv4(destinationIpText)) errors['endpoint.destinationIp'] = '目标 IP 需要是合法的 IPv4 地址';
  if (sourcePort === null) errors['endpoint.sourcePort'] = '源端口必须是 0–65535 的整数';
  if (destinationPort === null) errors['endpoint.destinationPort'] = '目标端口必须是 0–65535 的整数';
  if (typeof sourcePort === 'number' && !isValidPort(sourcePort)) errors['endpoint.sourcePort'] = '源端口范围为 0–65535';
  if (typeof destinationPort === 'number' && !isValidPort(destinationPort)) errors['endpoint.destinationPort'] = '目标端口范围为 0–65535';

  if (Object.keys(errors).length) return null;

  return {
    source: `${sourceIpText || defaults.sourceIp}:${sourcePort ?? defaults.sourcePort}`,
    destination: `${destinationIpText || defaults.destinationIp}:${destinationPort ?? defaults.destinationPort}`
  };
}

interface TcpResult {
  raw: string;
  scenario: PacketScenario;
  endpoints: TcpEndpoint | null;
  conflicts: FieldConflict[];
}

function buildTcp(input: TcpHandshakeInput | TcpDataInput): TcpResult {
  const conflicts: FieldConflict[] = [];
  const errors: FieldErrors = {};
  const isHandshake = input.scenario === 'handshake';
  const direction = input.direction;
  const endpoints = resolveTcpEndpoint(input.endpoint ?? {}, direction, errors);

  const seq = nonNegativeInt(input.seq);
  const ack = nonNegativeInt(input.ack);
  const window = nonNegativeInt(input.window);
  if (seq === null) errors['tcp.seq'] = '序列号必须是非负整数';
  if (ack === null) errors['tcp.ack'] = '确认号必须是非负整数';
  if (window === null || (typeof window === 'number' && window > 65535)) errors['tcp.window'] = '窗口大小必须是 0–65535 的整数';

  const flagsText = asText(input.flags) || (isHandshake ? (direction === 'request' ? 'SYN' : 'SYN,ACK') : 'ACK,PSH');
  const flags = normalizeFlags(flagsText);
  const unknown = flags.filter((flag) => !KNOWN_TCP_FLAGS.has(flag));
  if (unknown.length) {
    conflicts.push(conflict('tcp.flags', 'tcp-unknown-flags', `未知 TCP 标志位：${unknown.join(', ')}（支持 SYN/ACK/FIN/RST/PSH/URG）`, 'warning'));
  }

  const length = nonNegativeInt(input.payloadLength);
  if (length === null || (typeof length === 'number' && !Number.isSafeInteger(length))) {
    errors['tcp.payloadLength'] = '数据长度必须是非负整数';
  }
  const payloadLength = length ?? 0;

  if (isHandshake) {
    if (payloadLength > 0) {
      conflicts.push(conflict('tcp.payloadLength', 'tcp-handshake-with-data', `握手报文不应携带数据，但当前 Len=${payloadLength}`, 'error'));
    }
    if (flags.includes('PSH') || flags.includes('URG')) {
      conflicts.push(conflict('tcp.flags', 'tcp-handshake-data-flags', `握手标志中出现 PSH/URG（当前 ${flags.join(',')}），这些标志用于数据推送`, 'warning'));
    }
    if (flags.includes('SYN') && typeof ack === 'number' && direction === 'request' && ack !== 0) {
      conflicts.push(conflict('tcp.ack', 'tcp-syn-ack-nonzero', '首个 SYN 报文的 Ack 通常应为 0', 'warning'));
    }
    if (!flags.includes('SYN') && !flags.includes('FIN') && !flags.includes('RST')) {
      conflicts.push(conflict('tcp.flags', 'tcp-handshake-no-control-flag', `握手/控制报文至少应包含 SYN、FIN 或 RST 之一（当前 ${flags.join(',') || '无'}）`, 'warning'));
    }
  } else {
    if (payloadLength === 0) {
      conflicts.push(conflict('tcp.payloadLength', 'tcp-data-empty', '数据方向报文的 Len=0，实际是纯 ACK 而非数据段', 'warning'));
    }
    if (payloadLength > 0 && !flags.includes('PSH')) {
      conflicts.push(conflict('tcp.flags', 'tcp-data-without-push', '携带数据但未设置 PSH 标志（教学示例通常使用 ACK,PSH）', 'warning'));
    }
  }

  /* ----- render ----- */
  const parts = [
    `Seq=${seq ?? 0}`,
    `Ack=${ack ?? 0}`,
    `Flags=${flags.join(',') || 'ACK'}`,
    `Win=${window ?? 64240}`
  ];
  if (isHandshake) {
    const mss = nonNegativeInt(input.mss);
    const windowScale = nonNegativeInt(input.windowScale);
    if (mss === null) errors['tcp.mss'] = 'MSS 必须是非负整数';
    if (windowScale === null || (typeof windowScale === 'number' && windowScale > 14)) errors['tcp.windowScale'] = '窗口缩放因子应为 0–14';
    if (typeof mss === 'number') parts.push(`MSS=${mss}`);
    if (typeof windowScale === 'number') parts.push(`WS=${windowScale}`);
  }
  parts.push(`Len=${payloadLength}`);

  const route = endpoints ? `TCP ${endpoints.source} > ${endpoints.destination}` : 'TCP ? > ?';
  const raw = `${route} | ${parts.join(' | ')}`;

  const allConflicts = [
    ...Object.entries(errors).map(([fieldName, message]) => conflict(fieldName, 'field-required', message, 'error')),
    ...conflicts
  ];

  return { raw, scenario: input.scenario, endpoints, conflicts: allConflicts };
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

export interface BuildResult {
  raw: string;
  protocol: Protocol;
  scenario: PacketScenario;
  conflicts: BuilderConflict[];
  valid: boolean;
  packet: SimulatedPacket;
}

function isBuilderInput(value: unknown): value is BuilderInput {
  if (!value || typeof value !== 'object') return false;
  const input = value as { kind?: unknown; scenario?: unknown };
  if (input.kind !== 'http' && input.kind !== 'tcp') return false;
  return typeof input.scenario === 'string';
}

export function buildScenario(input: unknown, syncContentLength = true): BuildResult {
  if (!isBuilderInput(input)) {
    throw new Error('input.kind 必须是 "http" 或 "tcp"，且需要提供 scenario');
  }

  if (input.kind === 'http') {
    if ((input as { scenario?: unknown }).scenario === 'handshake') {
      throw new Error('HTTP 不支持 handshake 场景，请选择 request 或 response');
    }
    const result = buildHttp(input, syncContentLength);
    const valid = !result.conflicts.some((item) => item.severity === 'error');
    const packet = buildPacket('HTTP', result.scenario, result.raw, {}, { conflicts: result.conflicts });
    return { raw: result.raw, protocol: 'HTTP', scenario: result.scenario, conflicts: result.conflicts, valid, packet };
  }

  const result = buildTcp(input);
  const valid = !result.conflicts.some((item) => item.severity === 'error');
  const packet = buildPacket(
    'TCP',
    result.scenario,
    result.raw,
    result.endpoints ? { source: result.endpoints.source, destination: result.endpoints.destination } : {},
    { conflicts: result.conflicts }
  );
  return { raw: result.raw, protocol: 'TCP', scenario: result.scenario, conflicts: result.conflicts, valid, packet };
}
