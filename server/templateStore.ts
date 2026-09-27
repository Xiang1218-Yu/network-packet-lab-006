import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  BuilderInput,
  BuilderIssue,
  Protocol,
  ScenarioTemplate
} from '../shared/types.js';
import { validateBuilderInput } from './scenarioBuilder.js';

/**
 * User templates live in a JSON data file (gitignored) and are kept fully
 * separate from the built-in HTTP_SAMPLES / TCP_SAMPLES constants.
 */
const STORE_PATH = process.env.PACKETLAB_TEMPLATE_FILE
  ? process.env.PACKETLAB_TEMPLATE_FILE
  : join(process.cwd(), 'data', 'scenario-templates.json');

interface StoredTemplate extends ScenarioTemplate {}

let cache: StoredTemplate[] | null = null;

function load(): StoredTemplate[] {
  if (cache) return cache;
  try {
    if (existsSync(STORE_PATH)) {
      const parsed = JSON.parse(readFileSync(STORE_PATH, 'utf8')) as unknown;
      cache = Array.isArray(parsed) ? (parsed as StoredTemplate[]) : [];
    } else {
      cache = [];
    }
  } catch {
    cache = [];
  }
  return cache!;
}

/** Atomic-ish persist: write to a temp file then rename. */
function persist(): void {
  mkdirSync(dirname(STORE_PATH), { recursive: true });
  const temporary = `${STORE_PATH}.tmp`;
  writeFileSync(temporary, JSON.stringify(load(), null, 2), 'utf8');
  renameSync(temporary, STORE_PATH);
}

function createId(existing: StoredTemplate[]): string {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const suffix = (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`)
      .replace(/-/g, '')
      .slice(0, 12);
    const id = `tpl-${suffix}`;
    if (!existing.some((template) => template.id === id)) return id;
  }
  // Extremely unlikely fallback, still unique by construction.
  return `tpl-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
}

function isBuilderInput(value: unknown): value is BuilderInput {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<BuilderInput>;
  if (candidate.protocol !== 'HTTP' && candidate.protocol !== 'TCP') return false;
  return typeof candidate.scenario === 'string';
}

export interface TemplateOperationResult {
  template?: ScenarioTemplate;
  templates?: ScenarioTemplate[];
  issues: BuilderIssue[];
  error?: string;
  status?: number;
}

export function listTemplates(protocolFilter?: Protocol): ScenarioTemplate[] {
  const templates = load();
  return protocolFilter ? templates.filter((template) => template.protocol === protocolFilter) : [...templates];
}

export function saveTemplate(nameInput: unknown, input: unknown): TemplateOperationResult {
  const name = typeof nameInput === 'string' ? nameInput.trim() : '';
  if (!name) return { issues: [], error: '模板名称不能为空。', status: 400 };
  if (name.length > 64) return { issues: [], error: '模板名称不能超过 64 个字符。', status: 400 };
  if (!isBuilderInput(input)) return { issues: [], error: 'input 必须是合法的构建器输入。', status: 400 };

  const validated = validateBuilderInput(input);
  if (!validated.raw) {
    return { issues: validated.issues, error: '存在必填项缺失或字段冲突，修正后才能保存模板。', status: 422 };
  }

  const templates = load();
  const now = new Date().toISOString();
  const template: StoredTemplate = {
    id: createId(templates),
    name,
    protocol: input.protocol,
    scenario: input.scenario,
    input: validated.normalized,
    raw: validated.raw,
    createdAt: now,
    updatedAt: now
  };
  templates.push(template);
  persist();
  return { template, issues: validated.issues, templates };
}

export function updateTemplate(id: string, patch: { name?: unknown; input?: unknown }): TemplateOperationResult {
  const templates = load();
  const index = templates.findIndex((template) => template.id === id);
  if (index === -1) return { issues: [], error: `模板 ${id} 不存在。`, status: 404 };

  const current = templates[index];
  let nextName = current.name;
  let nextInput = current.input;
  let nextRaw = current.raw;
  let issues: BuilderIssue[] = [];

  if (patch.name !== undefined) {
    nextName = typeof patch.name === 'string' ? patch.name.trim() : '';
    if (!nextName) return { issues: [], error: '模板名称不能为空。', status: 400 };
    if (nextName.length > 64) return { issues: [], error: '模板名称不能超过 64 个字符。', status: 400 };
  }

  if (patch.input !== undefined) {
    if (!isBuilderInput(patch.input)) return { issues: [], error: 'input 必须是合法的构建器输入。', status: 400 };
    const validated = validateBuilderInput(patch.input);
    if (!validated.raw) {
      return { issues: validated.issues, error: '存在必填项缺失或字段冲突，修正后才能保存模板。', status: 422 };
    }
    nextInput = validated.normalized;
    nextRaw = validated.raw;
    issues = validated.issues;
  }

  const updated: StoredTemplate = {
    ...current,
    name: nextName,
    protocol: nextInput.protocol,
    scenario: nextInput.scenario,
    input: nextInput,
    raw: nextRaw,
    updatedAt: new Date().toISOString()
  };
  templates[index] = updated;
  persist();
  return { template: updated, issues, templates };
}

export function deleteTemplate(id: string): TemplateOperationResult {
  const templates = load();
  const next = templates.filter((template) => template.id !== id);
  if (next.length === templates.length) return { issues: [], error: `模板 ${id} 不存在。`, status: 404 };
  cache = next;
  persist();
  return { templates: next, issues: [] };
}
