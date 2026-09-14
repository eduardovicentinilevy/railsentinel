import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import mqtt from 'mqtt';
import { CORE, type OperatorAlarm, type TrackRestriction, type TspDecision } from '@railsentinel/contracts';
import { buildFeed } from './gtfs.js';

/**
 * operator-api - projecao de estado + IHM + exportador GTFS-RT.
 *
 * Fica na Zona de Integracao Operacional e so LE do barramento; o unico
 * caminho de escrita e o comando explicito de liberacao de secao, que exige
 * identificacao do operador. O feed GTFS-RT e servido daqui mas, em producao,
 * e publicado a partir da DMZ: dados que vao para Google Maps e Moovit nao
 * podem sair de um processo que tambem conversa com o barramento de controle.
 */

const CORE_URL = process.env.CORE_BROKER_URL ?? 'mqtt://127.0.0.1:1884';
const PORT = Number(process.env.PORT ?? 8080);
const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, '..', 'public');

const log = (lvl: string, msg: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), svc: 'operator-api', lvl, msg, ...extra }));

interface SystemState {
  at: string;
  fleet: Array<{ train_id: string; line: string; section_id: string; speed_kmh: number; schedule_dev_s: number; occupancy?: string; stale: boolean }>;
  open_incidents: string[];
  tsp_inhibitions: Array<{ crossing_id: string; reason: string }>;
  edge_nodes: Array<{ src: string; status: string; fps?: number; camera_link?: string; at: string }>;
  safety_violations_blocked: number;
}

const state = {
  system: null as SystemState | null,
  alarms: [] as OperatorAlarm[],
  restrictions: new Map<string, TrackRestriction>(),
  tsp: [] as TspDecision[],
  violations: [] as unknown[],
  rejected: [] as unknown[],
};

/** Clientes SSE conectados - a IHM recebe empurrado, sem polling. */
const sseClients = new Set<ServerResponse>();

function broadcast(event: string, data: unknown): void {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    res.write(frame);
  }
}

const bus = mqtt.connect(CORE_URL, { clientId: 'operator-api', clean: true, reconnectPeriod: 1000 });

bus.on('connect', () => {
  log('info', 'conectado ao barramento do nucleo', { url: CORE_URL });
  for (const t of [CORE.systemState, CORE.operatorAlarm, CORE.trackRestriction, CORE.tspDecision, CORE.safetyViolation, CORE.auditRejected]) {
    bus.subscribe(t, { qos: 1 });
  }
});

bus.on('message', (topic, payload) => {
  let obj: any;
  try { obj = JSON.parse(payload.toString('utf8')); } catch { return; }

  switch (topic) {
    case CORE.systemState:
      state.system = obj;
      broadcast('state', obj);
      break;
    case CORE.operatorAlarm:
      state.alarms.unshift(obj);
      state.alarms = state.alarms.slice(0, 100);
      broadcast('alarm', obj);
      log('warn', 'alarme na IHM', { title: obj.title, severity: obj.severity });
      break;
    case CORE.trackRestriction:
      if (obj.cleared) state.restrictions.delete(obj.section_id);
      else state.restrictions.set(obj.section_id, obj);
      broadcast('restriction', { restrictions: [...state.restrictions.values()] });
      break;
    case CORE.tspDecision:
      state.tsp.unshift(obj);
      state.tsp = state.tsp.slice(0, 50);
      broadcast('tsp', obj);
      break;
    case CORE.safetyViolation:
      state.violations.unshift(obj);
      broadcast('safety_violation', obj);
      break;
    case CORE.auditRejected:
      state.rejected.unshift(obj);
      state.rejected = state.rejected.slice(0, 100);
      broadcast('rejected', obj);
      break;
  }
});

/* ------------------------------------------------------------------ */

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

  if (url.pathname === '/' || url.pathname === '/index.html') {
    return send(res, 200, 'text/html; charset=utf-8', readFileSync(join(publicDir, 'index.html')));
  }

  if (url.pathname === '/api/state') {
    return json(res, 200, {
      system: state.system,
      alarms: state.alarms.slice(0, 30),
      restrictions: [...state.restrictions.values()],
      tsp: state.tsp.slice(0, 15),
      violations: state.violations.slice(0, 15),
      rejected: state.rejected.slice(0, 15),
    });
  }

  // Stream SSE: a IHM nao faz polling. Um painel de CCO com polling perde o
  // que importa no intervalo entre duas requisicoes.
  if (url.pathname === '/api/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
      Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
    });
    res.write(': conectado\n\n');
    if (state.system) res.write(`event: state\ndata: ${JSON.stringify(state.system)}\n\n`);
    sseClients.add(res);
    const ka = setInterval(() => res.write(': ka\n\n'), 15_000);
    req.on('close', () => { clearInterval(ka); sseClients.delete(res); });
    return;
  }

  if (url.pathname === '/api/gtfs-rt') {
    const feed = buildFeed({
      trains: (state.system?.fleet ?? []).map((t) => ({ ...t, run_id: `run-${t.train_id}`, next_stop_id: t.section_id })),
      alarms: state.alarms,
      restrictions: [...state.restrictions.values()],
    });
    return json(res, 200, feed);
  }

  // Unico caminho de escrita: liberacao de secao, com operador identificado.
  if (url.pathname === '/api/clear-section' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
    req.on('end', () => {
      try {
        const { section_id, operator_id } = JSON.parse(body || '{}');
        if (!section_id || !operator_id) return json(res, 400, { error: 'section_id e operator_id sao obrigatorios' });
        bus.publish('core/cmd/operator/clear_section', JSON.stringify({ section_id, operator_id, at: new Date().toISOString() }), { qos: 1 });
        log('info', 'liberacao de secao solicitada pela IHM', { section_id, operator_id });
        json(res, 202, { accepted: true, section_id });
      } catch {
        json(res, 400, { error: 'JSON invalido' });
      }
    });
    return;
  }

  if (url.pathname === '/healthz') return json(res, 200, { ok: true, sse_clients: sseClients.size, bus: bus.connected });

  json(res, 404, { error: 'nao encontrado' });
});

function json(res: ServerResponse, code: number, body: unknown): void {
  send(res, code, 'application/json; charset=utf-8', Buffer.from(JSON.stringify(body, null, 2)));
}
function send(res: ServerResponse, code: number, type: string, body: Buffer): void {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

server.listen(PORT, () => log('info', `IHM do operador em http://localhost:${PORT}`, { gtfs: `http://localhost:${PORT}/api/gtfs-rt` }));

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => { server.close(); bus.end(true); process.exit(0); });
}
