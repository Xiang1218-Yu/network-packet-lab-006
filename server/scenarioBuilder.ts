import type {
  BuilderInput,
  BuilderIssue,
  EndpointInput,
  HeaderInput,
  HttpBuilderInput,
  TcpBuilderInput,
  TcpFlag
} from '../shared/types.js';
import { TCP_FLAGS, utf8ByteLength } from '../shared/protocol.js';

/* ------------------------------------------------------------------ */
/* Constants                                                          */
/* ------------------------------------------------------------------ */

/** Canonical order used when rendering the Flags field of raw text. */
const FLAG_ORDER: Record<string, number> = { SYN: 0, ACK: 1, FIN: 2, RST: 3, PSH: 4, URG: 5 };

const HTTP_VERSIONS = new Set(['HTTP/1.0', 'HTTP/1.1', 'HTTP/2.0']);
const KNOWN_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

const STATUS_REASONS: Record<number, string> = {
  100: 'Continue', 101: 'Switching Protocols', 102: 'Processing', 103: 'Early Hints',
  200: 'OK', 201: 'Created', 202: 'Accepted', 203: 'Non-Authoritative Information',
  204: 'No Content', 205: 'Reset Content', 206: 'Partial Content',
  301: 'Moved Permanently', 302: 'Found', 303: 'See Other', 304: 'Not Modified',
  307: 'Temporary Redirect', 308: 'Permanent Redirect',
  400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found',
  405: 'Method Not Allowed', 408: 'Request Timeout', 409: 'Conflict', 413: 'Payload Too Large',
  418: "I'm a Teapot", 429: 'Too Many Requests',
  500: 'Internal Server Error', 501: 'Not Implemented', 502: 'Bad Gateway',
  503: 'Service Unavailable', 504: 'Gateway Timeout'
};

/* ------------------------------------------------------------------ */
/* Issue helpers                                                      */
/* ------------------------------------------------------------------ */

function issue(level: BuilderIssue['level'], field: string, message: string): BuilderIssue {
  return { level, field, message };
}

const CRLF = '\r\n';

/* ------------------------------------------------------------------ */
/* Value parsing                                                      */
/* ------------------------------------------------------------------ */

function asText(value: unknown, fallback = ''): string {
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : fallback;
  return typeof value === 'string' ? value : fallback;
}

/** Optional non-negative integer: absent/blank → fallback; malformed/out-of-range → error. */
function optionalInt(
  value: unknown,
  field: string,
  label: string,
  issues: BuilderIssue[],
  options: { fallback?: number; min?: number; max?: number } = {}
): number | undefined {
  const { fallback, min = 0, max = Number.MAX_SAFE_INTEGER } = options;
  const text = asText(value).trim();
  if (!text) return fallback;
  if (!/^\d+$/.test(text)) {
    issues.push(issue('error', field, `${label}必须是非负整数，当前值为“${text}”。`));
    return fallback;
  }
  const parsed = Number(text);
  if (parsed < min || parsed > max) {
    issues.push(issue('error', field, `${label}必须在 ${min}–${max} 之间，当前为 ${parsed}。`));
    return fallback;
  }
  return parsed;
}

function requireInt(value: unknown, field: string, label: string, issues: BuilderIssue[], min: number, max: number): number | undefined {
  const text = asText(value).trim();
  if (!text) {
    issues.push(issue('error', field, `必填项“${label}”不能为空。`));
    return undefined;
  }
  if (!/^\d+$/.test(text)) {
    issues.push(issue('error', field, `${label}必须是 ${min}–${max} 之间的整数，当前值为“${text}”。`));
    return undefined;
  }
  const parsed = Number(text);
  if (parsed < min || parsed > max) {
    issues.push(issue('error', field, `${label}必须在 ${min}–${max} 之间，当前为 ${parsed}。`));
    return undefined;
  }
  return parsed;
}

const ENDPOINT_PATTERN = /^(?:\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}|[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?)$/;

function parseEndpoint(
  value: unknown,
  field: string,
  label: string,
  issues: BuilderIssue[],
  options: { portRequired?: boolean } = {}
): EndpointInput | undefined {
  if (typeof value !== 'object' || value === null) {
    issues.push(issue('error', field, `必填项“${label}”缺失。`));
    return undefined;
  }
  const candidate = value as Partial<EndpointInput>;
  const host = asText(candidate.host).trim();
  if (!host) {
    issues.push(issue('error', `${field}.host`, `“${label}”的主机地址不能为空。`));
  } else if (!ENDPOINT_PATTERN.test(host)) {
    issues.push(issue('error', `${field}.host`, `“${label}”的主机地址“${host}”不是合法的 IPv4 或主机名。`));
  }
  // TCP endpoints always need a port; HTTP Host headers may omit it.
  const port = options.portRequired
    ? requireInt(candidate.port, `${field}.port`, `“${label}”端口`, issues, 1, 65535)
    : optionalInt(candidate.port, `${field}.port`, `“${label}”端口`, issues, { min: 1, max: 65535 });
  if (!host || (options.portRequired && port === undefined)) return undefined;
  return { host, port: port ?? '' };
}

function endpointText(endpoint: EndpointInput): string {
  return endpoint.port === '' || endpoint.port === undefined ? endpoint.host : `${endpoint.host}:${endpoint.port}`;
}

/* ------------------------------------------------------------------ */
/* Header normalisation                                               */
/* ------------------------------------------------------------------ */

const TOKEN_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

function normalizeHeaders(value: unknown, issues: BuilderIssue[], fieldPrefix: string): HeaderInput[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    issues.push(issue('error', fieldPrefix, 'Headers 必须是 { key, value } 数组。'));
    return [];
  }
  const seen = new Map<string, number>();
  const headers: HeaderInput[] = [];
  value.forEach((entry, index) => {
    const field = `${fieldPrefix}[${index}]`;
    if (typeof entry !== 'object' || entry === null) {
      issues.push(issue('error', field, '该 header 不是 { key, value } 对象。'));
      return;
    }
    const key = asText((entry as Partial<HeaderInput>).key).trim();
    const headerValue = asText((entry as Partial<HeaderInput>).value).trim();
    if (!key && !headerValue) return; // blank rows are simply ignored
    if (!key) {
      issues.push(issue('error', `${field}.key`, 'Header 名称不能为空。'));
      return;
    }
    if (!TOKEN_PATTERN.test(key)) {
      issues.push(issue('error', `${field}.key`, `Header 名称“${key}”包含非法字符。`));
      return;
    }
    if (/[\r\n]/.test(headerValue)) {
      issues.push(issue('error', `${field}.value`, `Header“${key}”的值不能包含换行。`));
      return;
    }
    const count = seen.get(key.toLowerCase()) ?? 0;
    if (count > 0) issues.push(issue('warning', field, `Header“${key}”重复出现 ${count + 1} 次。`));
    seen.set(key.toLowerCase(), count + 1);
    headers.push({ key, value: headerValue });
  });
  return headers;
}

/* ------------------------------------------------------------------ */
/* HTTP                                                               */
/* ------------------------------------------------------------------ */

interface NormalizedHttp {
  scenario: 'request' | 'response';
  method: string;
  target: string;
  version: string;
  statusCode?: number;
  reason?: string;
  headers: HeaderInput[];
  body: string;
}

function validateHttp(input: HttpBuilderInput, issues: BuilderIssue[]): NormalizedHttp | null {
  if (input.scenario !== 'request' && input.scenario !== 'response') {
    issues.push(issue('error', 'scenario', 'HTTP 构建器仅支持 request / response 场景。'));
    return null;
  }

  const version = asText(input.version, 'HTTP/1.1').trim().toUpperCase();
  if (!HTTP_VERSIONS.has(version)) {
    issues.push(issue('error', 'version', `HTTP 版本“${version}”不受支持，请使用 HTTP/1.0、HTTP/1.1 或 HTTP/2.0。`));
  }

  let headers = normalizeHeaders(input.headers, issues, 'headers');
  const body = asText(input.body);

  if (input.scenario === 'request') {
    const method = asText(input.method, 'GET').trim().toUpperCase();
    if (!method) {
      issues.push(issue('error', 'method', '必填项“请求方法”不能为空。'));
    } else if (!TOKEN_PATTERN.test(method)) {
      issues.push(issue('error', 'method', `请求方法“${method}”包含非法字符。`));
    } else if (!KNOWN_METHODS.has(method)) {
      issues.push(issue('warning', 'method', `请求方法“${method}”不是常见方法，请确认拼写。`));
    }

    const target = asText(input.target ?? input.path, '/').trim();
    if (!target) {
      issues.push(issue('error', 'target', '必填项“请求路径 / 目标”不能为空。'));
    } else if (/[\s]/.test(target)) {
      issues.push(issue('error', 'target', `请求目标“${target}”不能包含空白字符。`));
    }

    const endpoint = parseEndpoint(input.endpoint, 'endpoint', '目标端点', issues, { portRequired: false });
    const hostHeaderIndex = headers.findIndex((header) => header.key.toLowerCase() === 'host');
    if (hostHeaderIndex > -1 && endpoint) {
      const generated = endpointText(endpoint);
      if (headers[hostHeaderIndex].value !== generated) {
        issues.push(issue('error', `headers[${hostHeaderIndex}]`, `Host header“${headers[hostHeaderIndex].value}”与端点“${generated}”冲突，请删除 Host header 或保持二者一致。`));
      }
      headers = headers.filter((_, index) => index !== hostHeaderIndex);
    } else if (endpoint) {
      headers = [{ key: 'Host', value: endpointText(endpoint) }, ...headers];
    } else if (hostHeaderIndex === -1) {
      issues.push(issue('error', 'endpoint', '必填项“目标端点（Host）”缺失。'));
    }

    if (body.length > 0) {
      const safeMethods = new Set(['GET', 'HEAD', 'DELETE', 'OPTIONS']);
      if (safeMethods.has(method)) {
        issues.push(issue('warning', 'body', `${method} 请求通常不携带 body，请确认是否符合预期。`));
      }
      const contentLengthIndex = headers.findIndex((header) => header.key.toLowerCase() === 'content-length');
      if (contentLengthIndex === -1) {
        issues.push(issue('warning', 'headers', `请求包含 ${utf8ByteLength(body)} 字节 body，但缺少 Content-Length header。`));
      } else {
        const declared = headers[contentLengthIndex].value.trim();
        const actual = utf8ByteLength(body);
        if (!/^\d+$/.test(declared)) {
          issues.push(issue('error', `headers[${contentLengthIndex}]`, `Content-Length“${declared}”不是非负整数。`));
        } else if (Number(declared) !== actual) {
          issues.push(issue('error', `headers[${contentLengthIndex}]`, `Content-Length（${declared}）与实际 body 字节数（${actual}）不一致。`));
        }
      }
    }

    return { scenario: 'request', method, target, version, headers, body };
  }

  // response
  const statusCode = requireInt(input.statusCode, 'statusCode', '状态码', issues, 100, 599);
  let reason = asText(input.reason).trim();
  if (reason && /[\r\n]/.test(reason)) {
    issues.push(issue('error', 'reason', 'Reason phrase 不能包含换行。'));
    reason = reason.replace(/[\r\n]/g, ' ');
  }
  if (!reason && statusCode !== undefined) reason = STATUS_REASONS[statusCode] ?? '';
  if (statusCode !== undefined && !reason) {
    issues.push(issue('warning', 'reason', `未知状态码 ${statusCode} 没有内置 reason phrase，请手动填写。`));
  }

  const contentLengthIndex = headers.findIndex((header) => header.key.toLowerCase() === 'content-length');
  if (contentLengthIndex > -1) {
    const declared = headers[contentLengthIndex].value.trim();
    const actual = utf8ByteLength(body);
    if (!/^\d+$/.test(declared)) {
      issues.push(issue('error', `headers[${contentLengthIndex}]`, `Content-Length“${declared}”不是非负整数。`));
    } else if (Number(declared) !== actual) {
      issues.push(issue('error', `headers[${contentLengthIndex}]`, `Content-Length（${declared}）与实际 body 字节数（${actual}）不一致。`));
    }
  }

  if (body.length > 0 && statusCode !== undefined && (statusCode === 204 || statusCode === 304 || statusCode < 200)) {
    issues.push(issue('warning', 'body', `状态码 ${statusCode} 的响应按 RFC 规定不应携带 body。`));
  }
  if (body.length > 0 && contentLengthIndex === -1) {
    issues.push(issue('warning', 'headers', `响应 body 为 ${utf8ByteLength(body)} 字节，但缺少 Content-Length header。`));
  }

  return { scenario: 'response', method: '', target: '', version, statusCode, reason, headers, body };
}

function renderHttp(data: NormalizedHttp): string {
  const lines: string[] = [];
  if (data.scenario === 'request') {
    lines.push(`${data.method} ${data.target} ${data.version}`);
  } else {
    lines.push(`${data.version} ${data.statusCode}${data.reason ? ` ${data.reason}` : ''}`);
  }
  for (const header of data.headers) lines.push(`${header.key}: ${header.value}`);
  return `${lines.join(CRLF)}${CRLF}${CRLF}${data.body}`;
}

/* ------------------------------------------------------------------ */
/* TCP                                                                */
/* ------------------------------------------------------------------ */

interface NormalizedTcp {
  scenario: 'handshake' | 'request' | 'response';
  source: EndpointInput;
  destination: EndpointInput;
  flags: TcpFlag[];
  seq: number;
  ack: number;
  window: number;
  mss?: number;
  windowScale?: number;
  dataLength: number;
}

function validateTcp(input: TcpBuilderInput, issues: BuilderIssue[]): NormalizedTcp | null {
  if (input.scenario !== 'handshake' && input.scenario !== 'request' && input.scenario !== 'response') {
    issues.push(issue('error', 'scenario', 'TCP 构建器仅支持 handshake / request / response 场景。'));
    return null;
  }

  const source = parseEndpoint(input.source, 'source', '源端点', issues, { portRequired: true });
  const destination = parseEndpoint(input.destination, 'destination', '目标端点', issues, { portRequired: true });
  if (source && destination && endpointText(source) === endpointText(destination)) {
    issues.push(issue('error', 'destination', '源端点与目标端点不能相同。'));
  }

  // Flags
  const rawFlags = Array.isArray(input.flags) ? input.flags : asText(input.flags).split(/[\s,]+/);
  const flags = new Set<TcpFlag>();
  rawFlags.forEach((rawFlag, index) => {
    const name = asText(rawFlag).trim().toUpperCase();
    if (!name) return;
    if (!TCP_FLAGS.includes(name as TcpFlag)) {
      issues.push(issue('error', `flags[${index}]`, `TCP 标志“${name}”不受支持，可选值：${TCP_FLAGS.join(' / ')}。`));
      return;
    }
    flags.add(name as TcpFlag);
  });
  if (flags.size === 0) issues.push(issue('error', 'flags', '必填项“TCP 标志”至少需要选择一个。'));

  const seq = optionalInt(input.seq, 'seq', '序列号 Seq', issues, { fallback: 0 })!;
  const ack = optionalInt(input.ack, 'ack', '确认号 Ack', issues, { fallback: 0 })!;
  const window = optionalInt(input.window, 'window', '窗口 Win', issues, { fallback: 64240 })!;
  const mss = optionalInt(input.mss, 'mss', 'MSS', issues, { max: 1460 });
  const windowScale = optionalInt(input.windowScale, 'windowScale', '窗口缩放 WS', issues, { max: 14 });

  const isHandshake = input.scenario === 'handshake';
  const dataLength = optionalInt(input.dataLength, 'dataLength', '数据长度 Len', issues, {
    fallback: isHandshake ? 0 : 0
  })!;

  if (isHandshake) {
    if (dataLength > 0) {
      issues.push(issue('error', 'dataLength', `握手报文不应携带应用数据，但当前 Len=${dataLength}。请清空数据长度或切换到数据方向。`));
    }
    if (flags.has('PSH') || flags.has('URG')) {
      issues.push(issue('error', 'flags', `握手报文只允许 SYN / ACK / FIN / RST 控制标志，当前包含 ${[...flags].filter((flag) => flag === 'PSH' || flag === 'URG').join(',')}。`));
    }
  } else if (flags.has('SYN')) {
    issues.push(issue('warning', 'flags', '数据方向报文通常不携带 SYN，SYN 只出现在连接建立阶段。'));
  }

  if (mss !== undefined && !flags.has('SYN')) {
    issues.push(issue('warning', 'mss', 'MSS 选项只在 SYN 报文中通告，当前报文没有 SYN 标志。'));
  }
  if (windowScale !== undefined && !flags.has('SYN')) {
    issues.push(issue('warning', 'windowScale', '窗口缩放（WS）选项只在 SYN 报文中通告，当前报文没有 SYN 标志。'));
  }
  if (flags.has('RST') && dataLength > 0) {
    issues.push(issue('warning', 'dataLength', 'RST 报文通常不携带数据。'));
  }

  if (!source || !destination) return null;
  return {
    scenario: input.scenario,
    source,
    destination,
    flags: [...flags].sort((left, right) => FLAG_ORDER[left] - FLAG_ORDER[right]),
    seq,
    ack,
    window,
    ...(mss !== undefined ? { mss } : {}),
    ...(windowScale !== undefined ? { windowScale } : {}),
    dataLength
  };
}

function renderTcp(data: NormalizedTcp): string {
  const parts = [
    `TCP ${endpointText(data.source)} > ${endpointText(data.destination)}`,
    `Seq=${data.seq} Ack=${data.ack}`,
    `Flags=${data.flags.join(',')}`,
    `Win=${data.window}`
  ];
  if (data.mss !== undefined) parts.push(`MSS=${data.mss}`);
  if (data.windowScale !== undefined) parts.push(`WS=${data.windowScale}`);
  parts.push(`Len=${data.dataLength}`);
  return parts.join(' | ');
}

/* ------------------------------------------------------------------ */
/* Public API                                                         */
/* ------------------------------------------------------------------ */

export interface ValidatedBuilder {
  normalized: HttpBuilderInput | TcpBuilderInput;
  raw?: string;
  issues: BuilderIssue[];
}

/**
 * Normalise and validate a structured builder input.
 * When there are no error-level issues, `raw` contains simulator-format text.
 */
export function validateBuilderInput(input: unknown): ValidatedBuilder {
  const issues: BuilderIssue[] = [];
  if (typeof input !== 'object' || input === null) {
    return { normalized: { protocol: 'HTTP', scenario: 'request' }, raw: undefined, issues: [issue('error', 'input', '构建器输入必须是对象。')] };
  }
  const candidate = input as Partial<BuilderInput>;

  if (candidate.protocol === 'TCP') {
    const result = validateTcp(input as TcpBuilderInput, issues);
    if (!result || issues.some((item) => item.level === 'error')) {
      return { normalized: input as TcpBuilderInput, issues };
    }
    return { normalized: input as TcpBuilderInput, raw: renderTcp(result), issues };
  }

  if (candidate.protocol !== 'HTTP') {
    issues.push(issue('error', 'protocol', `未知协议“${String(candidate.protocol)}”，仅支持 HTTP / TCP。`));
    return { normalized: { protocol: 'HTTP', scenario: 'request' }, issues };
  }
  const result = validateHttp(input as HttpBuilderInput, issues);
  if (!result || issues.some((item) => item.level === 'error')) {
    return { normalized: input as HttpBuilderInput, issues };
  }
  return { normalized: input as HttpBuilderInput, raw: renderHttp(result), issues };
}
