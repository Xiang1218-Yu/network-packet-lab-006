export type Protocol = 'HTTP' | 'TCP';
export type PacketScenario = 'request' | 'response' | 'handshake';

export interface HexRow {
  offset: string;
  bytes: string[];
  ascii: string;
}

export interface ProtocolField {
  id: string;
  key: string;
  value: string;
  description: string;
  children?: ProtocolField[];
}

export interface TimelineEvent {
  id: string;
  timestamp: string;
  label: string;
  phase: 'ingress' | 'parse' | 'transport' | 'application' | 'egress';
  detail: string;
}

export interface SimulatedPacket {
  id: string;
  protocol: Protocol;
  scenario: PacketScenario;
  summary: string;
  raw: string;
  hex: HexRow[];
  fields: ProtocolField[];
  timeline: TimelineEvent[];
  metadata: {
    capturedAt: string;
    source: string;
    destination: string;
    length: number;
    checksum: string;
  };
}

export interface ParseRequest {
  protocol: Protocol;
  scenario: PacketScenario;
  raw: string;
}

/* ------------------------------------------------------------------ */
/* Scenario builder                                                   */
/* ------------------------------------------------------------------ */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';
export type TcpFlag = 'SYN' | 'ACK' | 'FIN' | 'RST' | 'PSH' | 'URG';
export type HandshakeStage = 'syn' | 'syn-ack' | 'ack';
export type TcpDirection = 'request' | 'response';
export type BuilderIssueLevel = 'error' | 'warning';

export interface HeaderInput {
  key: string;
  value: string;
}

export interface EndpointInput {
  host: string;
  port: number | string;
}

export interface HttpBuilderInput {
  protocol: 'HTTP';
  scenario: 'request' | 'response';
  // Request line / status line
  method?: HttpMethod | string;
  target?: string;
  path?: string;
  version?: string;
  statusCode?: number | string;
  reason?: string;
  headers?: HeaderInput[];
  body?: string;
  // Request only: endpoint host feeds the mandatory Host header
  endpoint?: EndpointInput;
}

export interface TcpBuilderInput {
  protocol: 'TCP';
  scenario: 'handshake' | TcpDirection;
  source: EndpointInput;
  destination: EndpointInput;
  flags: TcpFlag[] | string[];
  seq?: number | string;
  ack?: number | string;
  window?: number | string;
  /** SYN-only TCP options, rendered e.g. `MSS=1460 | WS=7` */
  mss?: number | string;
  windowScale?: number | string;
  /** Data length; forbidden (>0) on pure handshake segments */
  dataLength?: number | string;
}

export type BuilderInput = HttpBuilderInput | TcpBuilderInput;

export interface BuilderIssue {
  level: BuilderIssueLevel;
  field: string;
  message: string;
}

export interface BuilderResult {
  raw: string;
  packet: SimulatedPacket;
  issues: BuilderIssue[];
}

export interface ScenarioTemplate {
  id: string;
  name: string;
  protocol: Protocol;
  scenario: PacketScenario;
  input: BuilderInput;
  raw: string;
  createdAt: string;
  updatedAt: string;
}

export interface SaveTemplateRequest {
  name: string;
  input: BuilderInput;
}

export interface UpdateTemplateRequest {
  name?: string;
  input?: BuilderInput;
}
