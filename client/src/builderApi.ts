import type {
  BuilderConflict,
  BuilderInput,
  ScenarioTemplate,
  ScenarioTemplateSummary,
  SimulatedPacket
} from '../../shared/types';

const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:3001';

export interface BuiltScenario {
  raw: string;
  protocol: 'HTTP' | 'TCP';
  scenario: 'request' | 'response' | 'handshake';
  packet: SimulatedPacket;
  conflicts: BuilderConflict[];
  valid: boolean;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, init);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.error ?? `API 请求失败：${response.status}`);
  }
  return payload.data as T;
}

export function buildScenario(input: BuilderInput, syncContentLength = true): Promise<BuiltScenario> {
  return call<BuiltScenario>('/api/builder/build', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input, syncContentLength })
  });
}

export function listTemplates(protocol?: 'HTTP' | 'TCP'): Promise<ScenarioTemplateSummary[]> {
  return call<ScenarioTemplateSummary[]>(`/api/builder/templates${protocol ? `?protocol=${protocol}` : ''}`);
}

export function getTemplate(id: string): Promise<ScenarioTemplate> {
  return call<ScenarioTemplate>(`/api/builder/templates/${id}`);
}

export function createTemplate(name: string, input: BuilderInput): Promise<ScenarioTemplate> {
  return call<ScenarioTemplate>('/api/builder/templates', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, input })
  });
}

export function updateTemplate(id: string, name: string, input: BuilderInput): Promise<ScenarioTemplate> {
  return call<ScenarioTemplate>(`/api/builder/templates/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, input })
  });
}

export function deleteTemplate(id: string): Promise<{ id: string; deleted: boolean }> {
  return call<{ id: string; deleted: boolean }>(`/api/builder/templates/${id}`, { method: 'DELETE' });
}
