import express, { type Request, type Response } from 'express';
import type {
  BuilderInput,
  PacketScenario,
  ParseRequest,
  Protocol,
  SimulatedPacket
} from '../shared/types.js';
import { buildPacket } from './packets.js';
import { buildScenario } from './builder.js';
import { deleteTemplate, getTemplate, listTemplates, saveTemplate } from './scenario-store.js';

const app = express();
const port = Number(process.env.PORT ?? 3001);

app.use(express.json({ limit: '1mb' }));
app.use((request, response, next) => {
  response.header('Access-Control-Allow-Origin', '*');
  response.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  response.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  if (request.method === 'OPTIONS') return response.sendStatus(204);
  next();
});

function isProtocol(value: unknown): value is Protocol { return value === 'HTTP' || value === 'TCP'; }
function isScenario(value: unknown): value is PacketScenario { return value === 'request' || value === 'response' || value === 'handshake'; }

app.get('/api/health', (_request, response) => response.json({ ok: true, service: 'network-packet-lab-api' }));

app.get('/api/simulate', (request, response) => {
  const protocol = isProtocol(request.query.protocol) ? request.query.protocol : 'HTTP';
  const scenario = isScenario(request.query.scenario) ? request.query.scenario : (protocol === 'HTTP' ? 'request' : 'handshake');
  response.json({ data: buildPacket(protocol, scenario, '') });
});

/* Built-in samples only — user templates never appear here. */
app.get('/api/packets', (request, response) => {
  const protocol = isProtocol(request.query.protocol) ? request.query.protocol : 'HTTP';
  const scenarios: PacketScenario[] = protocol === 'HTTP' ? ['request', 'response'] : ['handshake', 'request', 'response'];
  response.json({ data: scenarios.map((scenario) => buildPacket(protocol, scenario, '')) });
});

app.post('/api/parse', (request: Request<unknown, unknown, Partial<ParseRequest>>, response: Response) => {
  const protocol = isProtocol(request.body?.protocol) ? request.body.protocol : 'HTTP';
  const scenario = isScenario(request.body?.scenario) ? request.body.scenario : 'request';
  const raw = typeof request.body?.raw === 'string' ? request.body.raw : '';
  if (!raw.trim()) return response.status(400).json({ error: 'raw is required' });
  response.json({ data: buildPacket(protocol, scenario, raw) });
});

/* ------------------------------------------------------------------ */
/* Scenario builder                                                    */
/* ------------------------------------------------------------------ */

app.post('/api/builder/build', (request: Request<unknown, unknown, { input?: unknown; syncContentLength?: unknown }>, response: Response) => {
  const input = request.body?.input ?? request.body;
  const sync = request.body?.syncContentLength !== false;
  try {
    const built = buildScenario(input, sync);
    response.json({
      data: {
        raw: built.raw,
        protocol: built.protocol,
        scenario: built.scenario,
        packet: built.packet,
        conflicts: built.conflicts,
        valid: built.valid
      }
    });
  } catch (cause) {
    response.status(400).json({ error: cause instanceof Error ? cause.message : '场景构建失败' });
  }
});

app.get('/api/builder/templates', (request, response) => {
  const protocol = isProtocol(request.query.protocol) ? request.query.protocol : undefined;
  response.json({ data: listTemplates(protocol) });
});

app.get('/api/builder/templates/:id', (request, response) => {
  const template = getTemplate(request.params.id);
  if (!template) return response.status(404).json({ error: '模板不存在' });
  response.json({ data: template });
});

app.post('/api/builder/templates', (request: Request<unknown, unknown, { name?: unknown; input?: unknown }>, response: Response) => {
  const input = request.body?.input as BuilderInput | undefined;
  const name = typeof request.body?.name === 'string' ? request.body.name : undefined;
  if (!input || (input.kind !== 'http' && input.kind !== 'tcp')) {
    return response.status(400).json({ error: '需要合法的 builder input（kind=http|tcp）' });
  }
  try {
    const { template } = saveTemplate({ name, input });
    response.status(201).json({ data: template });
  } catch (cause) {
    response.status(400).json({ error: cause instanceof Error ? cause.message : '模板保存失败' });
  }
});

app.put('/api/builder/templates/:id', (request: Request<{ id: string }, unknown, { name?: unknown; input?: unknown }>, response: Response) => {
  const existing = getTemplate(request.params.id);
  if (!existing) return response.status(404).json({ error: '模板不存在' });
  const input = (request.body?.input ?? existing.input) as BuilderInput;
  const name = typeof request.body?.name === 'string' ? request.body.name : undefined;
  if (input.kind !== 'http' && input.kind !== 'tcp') {
    return response.status(400).json({ error: '需要合法的 builder input（kind=http|tcp）' });
  }
  const { template } = saveTemplate({ id: existing.id, name, input });
  response.json({ data: template });
});

app.delete('/api/builder/templates/:id', (request, response) => {
  const removed = deleteTemplate(request.params.id);
  if (!removed) return response.status(404).json({ error: '模板不存在' });
  response.json({ data: { id: request.params.id, deleted: true } });
});

app.listen(port, () => {
  console.log(`Network Packet Lab API listening on http://localhost:${port}`);
});
