import mqtt from 'mqtt';
import {
  CORE, type HealthData, type IntrusionData, type Message, type TrainPositionData,
} from '@railsentinel/contracts';
import { SafetyGuard } from './safety-guard.js';
import { FleetRegistry } from './fleet.js';
import { HeadwayRegulator, resolveSetpoint, trainsRequiredForTimetable } from './headway.js';
import { TspController } from './tsp.js';
import { IntrusionHandler } from './intrusion.js';
import { getSection } from './topology.js';

/**
 * ats-core - camada logistica do ATS (Automatic Train Supervision).
 *
 * IMPORTANTE para leitura de certificacao: todo este servico e de INTEGRIDADE
 * BASICA (EN 50716). Ele nao intertrava rota, nao comanda freio e nao substitui
 * o ATP. Produz alarmes, aconselhamentos e pedidos de prioridade semaforica.
 * As funcoes vitais SIL 2/4 residem em processo separado, em hardware separado,
 * na Zona Interna Vital - fora deste repositorio por construcao, nao por
 * omissao.
 */

const CORE_URL = process.env.CORE_BROKER_URL ?? 'mqtt://127.0.0.1:1884';
const REGULATION_PERIOD_MS = Number(process.env.REGULATION_PERIOD_MS ?? 10_000);

const log = (lvl: string, msg: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), svc: 'ats-core', lvl, msg, ...extra }));

const guard = new SafetyGuard();
const fleet = new FleetRegistry();
const regulator = new HeadwayRegulator();
const tsp = new TspController(guard);
const intrusion = new IntrusionHandler(guard, fleet, tsp);

const bus = mqtt.connect(CORE_URL, { clientId: 'ats-core', clean: true, reconnectPeriod: 1000 });

/** Estado de saude dos nos de borda - alimenta o principio fail-visible. */
const edgeHealth = new Map<string, HealthData & { src: string; at: string }>();

guard.onViolation((v) => {
  // Violacao de particao e evento de seguranca funcional, nao erro de aplicacao.
  // Vai para trilha de auditoria imutavel e para o painel do operador.
  log('error', 'VIOLACAO DE PARTICAO EN 50716 barrada', v as unknown as Record<string, unknown>);
  bus.publish(CORE.safetyViolation, JSON.stringify(v), { qos: 1 });
});

bus.on('connect', () => {
  log('info', 'conectado ao barramento do nucleo', { url: CORE_URL });
  const subs = [CORE.normalizedIntrusion, CORE.normalizedHealth, CORE.normalizedPosition, 'core/cmd/operator/#'];
  for (const t of subs) bus.subscribe(t, { qos: 1 });
  log('info', 'ATS ativo - classe de integridade: basic (EN 50716)', { subscriptions: subs });
});

bus.on('error', (e) => log('error', 'erro no barramento', { err: e.message }));

/** Mensagem ja normalizada pelo gateway, com metadados de ingestao anexados. */
type Ingested<T> = Message<T> & { _ingest?: { latency_ms: number; gaps: number } };

bus.on('message', (topic, payload) => {
  let msg: Ingested<any>;
  try {
    msg = JSON.parse(payload.toString('utf8'));
  } catch {
    return;
  }

  switch (topic) {
    case CORE.normalizedIntrusion:
      onIntrusion(msg as Ingested<IntrusionData>);
      break;
    case CORE.normalizedHealth:
      onHealth(msg as Ingested<HealthData>);
      break;
    case CORE.normalizedPosition:
      onPosition(msg as Ingested<TrainPositionData>);
      break;
    default:
      if (topic.startsWith('core/cmd/operator/')) onOperatorCommand(topic, msg as unknown as Record<string, unknown>);
  }
});

/* ------------------------------------------------------------------ */
/* Fluxo principal: invasao de via                                      */
/* ------------------------------------------------------------------ */

function onIntrusion(msg: Ingested<IntrusionData>): void {
  const t0 = performance.now();
  const outcome = intrusion.handle(msg);

  if (!outcome.accepted) {
    log('info', 'deteccao filtrada antes de virar alarme', {
      reason: outcome.reason, src: msg.env.src, conf: msg.data.object.conf, class: msg.data.object.class,
    });
    return;
  }

  if (outcome.alarm) {
    bus.publish(CORE.operatorAlarm, JSON.stringify(outcome.alarm), { qos: 1 });
  }
  if (outcome.restriction) {
    bus.publish(CORE.trackRestriction, JSON.stringify(outcome.restriction), { qos: 1, retain: true });
  }
  for (const rev of outcome.tspRevocations) {
    bus.publish(CORE.tspDecision, JSON.stringify(rev), { qos: 1 });
  }

  const decisionMs = performance.now() - t0;

  if (outcome.kind === 'clear_candidate') {
    log('info', 'liberacao candidata - aguardando confirmacao do operador', {
      incident_id: outcome.incident_id, section: msg.data.track.section_id,
      nota: 'a restricao permanece ativa; somente o operador reabre a secao',
    });
    publishSystemState();
    return;
  }

  log('warn', 'INCIDENTE DE VIA processado', {
    incident_id: outcome.incident_id,
    section: msg.data.track.section_id,
    object: msg.data.object.class,
    confidence: msg.data.object.conf,
    alarm: outcome.alarm?.alarm_id,
    restriction: outcome.restriction?.restriction_id,
    restriction_kind: outcome.restriction?.kind,
    tsp_revoked: outcome.tspRevocations.map((r) => r.crossing_id),
    trains_at_risk: outcome.affectedTrains.map((t) => ({ id: t.train_id, section: t.section_id, speed: t.speed_kmh, stale: t.stale })),
    edge_to_cco_ms: msg._ingest?.latency_ms,
    ats_decision_ms: Number(decisionMs.toFixed(2)),
  });

  publishSystemState();
}

function onHealth(msg: Ingested<HealthData>): void {
  const prev = edgeHealth.get(msg.env.src);
  edgeHealth.set(msg.env.src, { ...msg.data, src: msg.env.src, at: msg.env.ts });

  if (prev && prev.status !== msg.data.status) {
    log(msg.data.status === 'ok' ? 'info' : 'warn', 'mudanca de estado de no de borda', {
      src: msg.env.src, from: prev.status, to: msg.data.status, reason: msg.data.reason,
    });
    if (msg.data.status === 'offline' || msg.data.status === 'fault') {
      // Fail-visible: um no cego nao pode ser confundido com "via livre".
      bus.publish(CORE.operatorAlarm, JSON.stringify({
        alarm_id: `hb-${Date.now()}`,
        severity: 'major',
        title: `Cobertura de deteccao perdida: ${msg.env.src}`,
        detail: `O no de borda esta ${msg.data.status}${msg.data.reason ? ` (${msg.data.reason})` : ''}. ` +
          `A secao coberta por este no deixou de ter deteccao automatica de invasao. ` +
          `AUSENCIA DE ALERTA NAO SIGNIFICA VIA LIVRE neste trecho.`,
        ...(msg.env.zone ? { zone: msg.env.zone } : {}),
        raised_at: new Date().toISOString(),
        acknowledged: false,
        provenance: { integrity_class: msg.env.class, source: msg.env.src },
        actions: ['Verificar enlace do no', 'Acionar manutencao de campo', 'Reforcar vigilancia por CFTV no trecho'],
      }), { qos: 1 });
      publishSystemState();
    }
  }
}

function onPosition(msg: Ingested<TrainPositionData>): void {
  fleet.upsert(msg.data, msg.env.ts);

  // TSP e avaliado a cada atualizacao de posicao: a janela de decisao e curta.
  const train = fleet.get(msg.data.train_id);
  if (!train) return;

  // A classe vem do envelope (ja conferida contra o teto do dispositivo na
  // fronteira), nunca fixada no codigo. Telemetria de Integridade Basica chega
  // ao guard como 'basic' e simplesmente nao concede prioridade.
  const evaluation = tsp.evaluate(train, msg.env.class, msg.env.id);
  if (evaluation.decision) {
    const ntcip = tsp.toNtcip(evaluation.decision);
    bus.publish(CORE.tspDecision, JSON.stringify(evaluation.decision), { qos: 1 });
    log('info', 'prioridade semaforica solicitada', {
      crossing: evaluation.decision.crossing_id, train: train.train_id,
      strategy: evaluation.decision.ntcip_strategy, eta_s: Math.round(evaluation.eta_s ?? 0),
      delay_s: train.schedule_dev_s, ntcip_endpoint: ntcip?.endpoint, mib: ntcip?.mib_objects,
    });
  }
}

function onOperatorCommand(topic: string, cmd: Record<string, unknown>): void {
  if (topic.endsWith('/clear_section')) {
    const sectionId = String(cmd.section_id ?? '');
    const result = intrusion.operatorClear(sectionId);
    log('info', 'liberacao confirmada pelo operador', {
      section: sectionId, released: result.released, crossings_restored: result.crossings,
      operator: cmd.operator_id ?? 'desconhecido',
    });
    if (result.released) {
      bus.publish(CORE.trackRestriction, JSON.stringify({ restriction_id: '', section_id: sectionId, cleared: true, cleared_by: cmd.operator_id, cleared_at: new Date().toISOString() }), { qos: 1, retain: true });
      publishSystemState();
    }
  }
}

/* ------------------------------------------------------------------ */
/* Malha periodica de regulacao de headway                              */
/* ------------------------------------------------------------------ */

/** Evita repetir o aviso de planejamento a cada ciclo de 10s. */
const infeasibilityReported = new Set<string>();

setInterval(() => {
  for (const line of ['L1', 'L2'] as const) {
    const trains = fleet.onLine(line);
    const active = trains.filter((t) => !t.stale);

    // Divergencia entre quadro de horarios e frota presente e assunto de
    // PLANEJAMENTO, nao de controle. Reportar uma vez e seguir regulando pelo
    // alcancavel e melhor que saturar os atuadores em silencio perseguindo um
    // intervalo que a frota nao sustenta.
    if (active.length >= 2) {
      const sp = resolveSetpoint(line, active.length);
      if (sp.infeasible && !infeasibilityReported.has(line)) {
        infeasibilityReported.add(line);
        log('warn', 'frota insuficiente para o headway do quadro de horarios', {
          line, timetable_headway_s: sp.timetable_s, achievable_headway_s: sp.feasible_s,
          cycle_time_s: sp.cycle_time_s, trains_present: sp.trains,
          trains_required: trainsRequiredForTimetable(line),
          nota: `Com ${sp.trains} composicao(oes) e ciclo de ${sp.cycle_time_s}s o intervalo real e ${sp.feasible_s}s, ` +
            `maior que os ${sp.timetable_s}s anunciados. A malha equaliza em ${sp.setpoint_s}s; fechar a diferenca ` +
            `exige ${trainsRequiredForTimetable(line)} composicoes ou revisao do quadro. Nao e ajuste de controle.`,
        });
      } else if (!sp.infeasible) {
        infeasibilityReported.delete(line);
      }
    }

    const cmds = regulator.regulate(line, trains);
    for (const cmd of cmds) {
      if (!guard.authorize('adjust_dwell_time', 'basic', `reg-${cmd.train_id}`).permitted) continue;
      if (Math.abs(cmd.dwell_delta_s) < 3 && cmd.coast_pct === 0) continue; // nada material a comandar
      bus.publish(`core/cmd/train/${cmd.train_id}/regulation`, JSON.stringify(cmd), { qos: 1 });
      log('info', 'ajuste de regulacao emitido', {
        line, train: cmd.train_id, dwell_s: cmd.dwell_s, delta_s: cmd.dwell_delta_s,
        coast_pct: cmd.coast_pct, headway_error_s: cmd.headway_error_s, setpoint_s: cmd.setpoint_s,
      });
    }
  }
  publishSystemState();
}, REGULATION_PERIOD_MS).unref();

/* ------------------------------------------------------------------ */

function publishSystemState(): void {
  const trains = fleet.all();
  const state = {
    at: new Date().toISOString(),
    integrity_class: 'basic',
    fleet: trains.map((t) => ({
      train_id: t.train_id, line: getSection(t.section_id)?.line ?? '?', section_id: t.section_id,
      speed_kmh: t.speed_kmh, schedule_dev_s: t.schedule_dev_s ?? 0, occupancy: t.occupancy, stale: t.stale,
    })),
    open_incidents: intrusion.openIncidents(),
    tsp_inhibitions: tsp.inhibitions(),
    edge_nodes: [...edgeHealth.values()].map((h) => ({ src: h.src, status: h.status, fps: h.fps, camera_link: h.camera_link, at: h.at })),
    safety_violations_blocked: guard.violations.length,
  };
  bus.publish(CORE.systemState, JSON.stringify(state), { qos: 0, retain: true });
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => { log('info', 'encerrando ats-core'); bus.end(true); process.exit(0); });
}
