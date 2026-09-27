import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BuilderInput, ScenarioTemplate, ScenarioTemplateSummary } from '../shared/types.js';
import { buildScenario } from './builder.js';

/**
 * Saved templates live in their own JSON file, completely separate from the
 * built-in HTTP_SAMPLES / TCP_SAMPLES constants: deleting or editing a
 * template can never modify a built-in sample.
 */
const DATA_FILE = process.env.PACKET_LAB_DATA_FILE
  ? resolve(process.env.PACKET_LAB_DATA_FILE)
  : resolve(process.cwd(), 'data', 'scenario-templates.json');

interface TemplateFile {
  version: 1;
  templates: ScenarioTemplate[];
}

function loadFile(): TemplateFile {
  try {
    if (existsSync(DATA_FILE)) {
      const parsed = JSON.parse(readFileSync(DATA_FILE, 'utf8')) as TemplateFile;
      if (Array.isArray(parsed?.templates)) return { version: 1, templates: parsed.templates };
    }
  } catch (cause) {
    console.warn(`[scenario-store] 无法读取模板文件 ${DATA_FILE}，将从空存储开始:`, cause instanceof Error ? cause.message : cause);
  }
  return { version: 1, templates: [] };
}

function saveFile(file: TemplateFile): void {
  mkdirSync(dirname(DATA_FILE), { recursive: true });
  writeFileSync(DATA_FILE, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
}

function toSummary(template: ScenarioTemplate): ScenarioTemplateSummary {
  return {
    id: template.id,
    name: template.name,
    protocol: template.protocol,
    scenario: template.scenario,
    createdAt: template.createdAt,
    updatedAt: template.updatedAt,
    valid: template.valid,
    conflictCount: template.conflicts.length
  };
}

export function listTemplates(protocol?: string): ScenarioTemplateSummary[] {
  const { templates } = loadFile();
  return templates
    .filter((template) => !protocol || template.protocol === protocol)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map(toSummary);
}

export function getTemplate(id: string): ScenarioTemplate | undefined {
  return loadFile().templates.find((template) => template.id === id);
}

export interface SaveTemplateOptions {
  id?: string;
  name?: string;
  input: BuilderInput;
}

/** Create or update a template. Rebuilding raw keeps saved text in sync with input. */
export function saveTemplate(options: SaveTemplateOptions): { template: ScenarioTemplate; created: boolean } {
  const file = loadFile();
  const now = new Date().toISOString();
  const built = buildScenario(options.input, true);

  let template: ScenarioTemplate;
  let created = false;
  const existing = options.id ? file.templates.find((item) => item.id === options.id) : undefined;

  if (existing) {
    template = {
      ...existing,
      name: options.name?.trim() || existing.name,
      input: options.input,
      raw: built.raw,
      protocol: built.protocol,
      scenario: built.scenario,
      conflicts: built.conflicts,
      valid: built.valid,
      updatedAt: now
    };
  } else {
    created = true;
    const name = options.name?.trim()
      || `${built.protocol} ${built.scenario} ${new Date().toLocaleString('zh-CN', { hour12: false })}`;
    template = {
      id: `tpl-${randomUUID()}`,
      name,
      createdAt: now,
      updatedAt: now,
      input: options.input,
      raw: built.raw,
      protocol: built.protocol,
      scenario: built.scenario,
      conflicts: built.conflicts,
      valid: built.valid,
      builtin: false
    };
    file.templates.push(template);
  }

  if (existing) {
    const index = file.templates.findIndex((item) => item.id === existing.id);
    file.templates[index] = template;
  }
  saveFile(file);
  return { template, created };
}

export function deleteTemplate(id: string): boolean {
  const file = loadFile();
  const next = file.templates.filter((template) => template.id !== id);
  if (next.length === file.templates.length) return false;
  saveFile({ ...file, templates: next });
  return true;
}
