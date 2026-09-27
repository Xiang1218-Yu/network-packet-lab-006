export type Protocol = 'HTTP' | 'TCP';
export type PacketScenario = 'request' | 'response' | 'handshake';
export type TcpDirection = 'request' | 'response';

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
  /** Present when the packet was produced by the scenario builder. */
  conflicts?: BuilderConflict[];
  /** Present when the packet was loaded from a saved template. */
  templateId?: string;
}

export interface ParseRequest {
  protocol: Protocol;
  scenario: PacketScenario;
  raw: string;
}

/* ------------------------------------------------------------------ */
/* Scenario builder                                                    */
/* ------------------------------------------------------------------

/** Builder field path, e.g. "response.status" or "tcp.window". */
export type BuilderFieldPath = string;

export type BuilderConflictSeverity = 'error' | 'warning';

export interface BuilderConflict {
  field: BuilderFieldPath;
  code: string;
  message: string;
  severity: BuilderConflictSeverity;
}

/** Structured input shared by HTTP request / response forms. */
export interface HttpBuilderInput {
  kind: 'http';
  scenario: 'request' | 'response';
  name?: string;
  request?: {
    method?: string;
    target?: string;
    version?: string;
  };
  response?: {
    version?: string;
    status?: string | number;
    reason?: string;
  };
  /** Host / endpoint the exchange targets; Host header derives from it. */
  host?: string;
  headers: Array<{ key: string; value: string }>;
  body?: string;
}

/** Structured input for TCP handshake (SYN / SYN-ACK / FIN …) segments. */
export interface TcpHandshakeInput {
  kind: 'tcp';
  scenario: 'handshake';
  name?: string;
  direction: TcpDirection;
  endpoint?: {
    sourceIp?: string;
    sourcePort?: string | number;
    destinationIp?: string;
    destinationPort?: string | number;
  };
  seq?: string | number;
  ack?: string | number;
  flags?: string;
  window?: string | number;
  mss?: string | number;
  windowScale?: string | number;
  /** Must stay empty/0 for a pure handshake; carrying data is a conflict. */
  payloadLength?: string | number;
}

/** Structured input for TCP data segments (request/response direction). */
export interface TcpDataInput {
  kind: 'tcp';
  scenario: TcpDirection;
  name?: string;
  direction: TcpDirection;
  endpoint?: {
    sourceIp?: string;
    sourcePort?: string | number;
    destinationIp?: string;
    destinationPort?: string | number;
  };
  seq?: string | number;
  ack?: string | number;
  flags?: string;
  window?: string | number;
  payloadLength?: string | number;
}

export type BuilderInput = HttpBuilderInput | TcpHandshakeInput | TcpDataInput;

export interface BuildScenarioRequest {
  input: BuilderInput;
  /**
   * When true (default) an auto Content-Length is added/synced on HTTP
   * messages. Set false to keep the user-provided headers untouched so
   * conflicts remain visible for teaching purposes.
   */
  syncContentLength?: boolean;
}

export interface BuildScenarioResponse {
  data: {
    raw: string;
    protocol: Protocol;
    scenario: PacketScenario;
    packet: SimulatedPacket;
    conflicts: BuilderConflict[];
    valid: boolean;
  };
}

export interface ScenarioTemplate {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  input: BuilderInput;
  raw: string;
  protocol: Protocol;
  scenario: PacketScenario;
  conflicts: BuilderConflict[];
  valid: boolean;
  builtin?: false;
}

export interface ScenarioTemplateSummary {
  id: string;
  name: string;
  protocol: Protocol;
  scenario: PacketScenario;
  createdAt: string;
  updatedAt: string;
  valid: boolean;
  conflictCount: number;
}
