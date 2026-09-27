import type { HandshakeStage, TcpFlag } from './types.js';

export const TCP_FLAGS: TcpFlag[] = ['SYN', 'ACK', 'FIN', 'RST', 'PSH', 'URG'];

/** Sensible defaults per handshake stage, so a demo SYN/SYN-ACK/ACK is one click away. */
export interface HandshakePreset {
  flags: TcpFlag[];
  seq: number;
  ack: number;
  dataLength: number;
  window: number;
}

export const HANDSHAKE_PRESETS: Record<HandshakeStage, HandshakePreset> = {
  syn: { flags: ['SYN'], seq: 0, ack: 0, dataLength: 0, window: 64240 },
  'syn-ack': { flags: ['SYN', 'ACK'], seq: 0, ack: 1, dataLength: 0, window: 65160 },
  ack: { flags: ['ACK'], seq: 1, ack: 1, dataLength: 0, window: 64240 }
};

/** Byte length of a UTF-8 string, shared by client hints and server validation. */
export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}
