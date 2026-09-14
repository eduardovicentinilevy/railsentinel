import snmp from 'net-snmp';
import mqtt from 'mqtt';
import { SignalController, type PhaseConfig, type PriorityRequest } from './controller.js';
import { OID, COLOR_CODE } from './mib.js';

/**
 * Emulador de controlador semaforico NTCIP 1202 - agente SNMP em malha fechada.
 *
 * Este e o HIL exigido pela Fase 1. O ats-core faz SNMP SET dos objetos de
 * prioridade; o emulador aplica sobre a maquina de estados respeitando verde
 * minimo, amarelo, vermelho-geral e verde maximo; e devolve o estado real por
 * SNMP GET. A malha fecha porque o CCO le de volta o que o controlador
 * efetivamente fez - que frequentemente nao e o que ele pediu.
 *
 * Um emulador que apenas registrasse os SETs e respondesse 'ok' provaria nada.
 * O valor esta na recusa: 'verde maximo ja atingido', 'extensao pedida com a
 * fase fora de verde'. E isso que expoe se o TSP oscila.
 */

const SNMP_PORT = Number(process.env.NTCIP_PORT ?? 1161);
const BUS_URL = process.env.CORE_BROKER_URL ?? 'mqtt://127.0.0.1:1884';
const TICK_MS = Number(process.env.NTCIP_TICK_MS ?? 1000);
const ACCEL = Number(process.env.NTCIP_ACCEL ?? 5);

const log = (lvl: string, msg: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), svc: 'ntcip-emulator', lvl, msg, ...extra }));

/** Plano de tempos tipico de cruzamento urbano com VLT (CET-Santos). */
function standardPhases(vltPhase: number): PhaseConfig[] {
  const cross = vltPhase === 2 ? 4 : 2;
  return [
    { phase: vltPhase, minGreen: 8,  maxGreen: 45, yellow: 3, allRed: 2, splitGreen: 22, label: 'longitudinal VLT' },
    { phase: cross,    minGreen: 12, maxGreen: 50, yellow: 3, allRed: 2, splitGreen: 28, label: 'transversal' },
    { phase: 8,        minGreen: 7,  maxGreen: 25, yellow: 3, allRed: 2, splitGreen: 12, label: 'pedestre/conversao' },
  ];
}

/** Controladores emulados, um por cruzamento do modelo topologico. */
const CONTROLLERS = new Map<number, SignalController>([
  [1161, new SignalController('XC-ANA-COSTA', standardPhases(2))],
  [1162, new SignalController('XC-F-GLICERIO', standardPhases(4))],
  [1163, new SignalController('XC-CAMPOS-MELLO', standardPhases(2))],
  [1164, new SignalController('XC-JOAO-PESSOA', standardPhases(6))],
  [1165, new SignalController('XC-CONSTITUICAO', standardPhases(2))],
]);

const bus = mqtt.connect(BUS_URL, { clientId: 'ntcip-emulator' });
bus.on('connect', () => log('info', 'conectado ao barramento (HIL)', { url: BUS_URL }));

/** Estado do pedido corrente por controlador, montado pelos SETs sucessivos. */
const pending = new Map<string, Partial<PriorityRequest>>();

function makeAgent(port: number, ctl: SignalController) {
  const store = new Map<string, { type: number; value: number | string }>();

  const refresh = () => {
    store.set(OID.prsActivePhase, { type: snmp.ObjectType.Integer, value: ctl.state.activePhase });
    store.set(OID.prsActiveColor, { type: snmp.ObjectType.Integer, value: COLOR_CODE[ctl.state.color] });
    store.set(OID.phaseStatusGroupGreens, { type: snmp.ObjectType.Integer, value: ctl.state.color === 'green' ? ctl.state.activePhase : 0 });
    store.set(OID.phaseStatusGroupYellows, { type: snmp.ObjectType.Integer, value: ctl.state.color === 'yellow' ? ctl.state.activePhase : 0 });
    store.set(OID.phaseStatusGroupReds, { type: snmp.ObjectType.Integer, value: ctl.state.color === 'all_red' ? ctl.state.activePhase : 0 });
    const vlt = ctl.phases[0]!.phase;
    store.set(OID.prsSecondsUntilGreen, { type: snmp.ObjectType.Integer, value: ctl.secondsUntilGreen(vlt) });
  };
  refresh();

  const agent = snmp.createAgent({ port, disableAuthorization: true }, (error: Error | null) => {
    if (error) log('error', 'erro no agente SNMP', { controller: ctl.id, err: error.message });
  });

  const mib = agent.getMib();
  // net-snmp exige providers declarados; usamos um handler escalar por OID.
  for (const oid of Object.values(OID)) {
    try {
      mib.registerProvider({
        name: oid.replace(/\./g, '_'),
        type: snmp.MibProviderType.Scalar,
        oid,
        scalarType: snmp.ObjectType.Integer,
        handler: (mibRequest: any) => {
          refresh();
          const v = store.get(oid);
          mibRequest.done({ type: snmp.ObjectType.Integer, value: typeof v?.value === 'number' ? v.value : 0 });
        },
      });
      mib.setScalarValue(oid.replace(/\./g, '_'), 0);
    } catch {
      // OIDs duplicados no mapa (aliases) - ignorar silenciosamente.
    }
  }

  return { agent, store, refresh };
}

const agents = new Map<number, ReturnType<typeof makeAgent>>();
for (const [port, ctl] of CONTROLLERS) {
  agents.set(port, makeAgent(port, ctl));
  log('info', 'controlador emulado no ar', {
    controller: ctl.id, snmp_port: port,
    fases: ctl.phases.map((p) => `${p.phase}:${p.label} (min ${p.minGreen}s, split ${p.splitGreen}s, max ${p.maxGreen}s)`),
  });
}

/**
 * Canal de comando do HIL.
 *
 * net-snmp em modo agente nao expoe hook de SET com a semantica que precisamos
 * (aplicar um pedido composto de varios objetos como uma transacao), entao o
 * pedido de prioridade chega por um canal dedicado e o SNMP serve a LEITURA de
 * estado - que e o lado que importa para fechar a malha. Os OIDs sao os mesmos
 * do equipamento real; a Fase 2 troca este canal por SET SNMP autenticado
 * (SNMPv3) sem mexer na maquina de estados nem no cliente de leitura.
 */
bus.on('connect', () => {
  bus.subscribe('ntcip/+/priority_request', { qos: 1 });
  bus.subscribe('ntcip/+/query', { qos: 0 });
});

bus.on('message', (topic, payload) => {
  const m = /^ntcip\/([^/]+)\/(priority_request|query)$/.exec(topic);
  if (!m) return;
  const [, crossingId, kind] = m;

  const entry = [...CONTROLLERS.entries()].find(([, c]) => c.id === crossingId);
  if (!entry) return;
  const [port, ctl] = entry;

  if (kind === 'query') {
    publishState(port, ctl);
    return;
  }

  let req: PriorityRequest;
  try { req = JSON.parse(payload.toString('utf8')); } catch { return; }

  const outcome = ctl.applyPriorityRequest(req);
  log(outcome.granted ? 'info' : 'warn', outcome.granted ? 'pedido de prioridade ATENDIDO' : 'pedido de prioridade RECUSADO', {
    controller: ctl.id, strategy: req.strategy, phase: req.phase, request_id: req.requestId,
    ...(outcome.granted ? { effect: outcome.effect, delay_s: outcome.delaySeconds } : { reason: outcome.reason }),
  });

  bus.publish(`ntcip/${ctl.id}/grant`, JSON.stringify({
    crossing_id: ctl.id, request_id: req.requestId, at: new Date().toISOString(), ...outcome,
    seconds_until_green: ctl.secondsUntilGreen(req.phase),
  }), { qos: 1 });

  publishState(port, ctl);
});

function publishState(port: number, ctl: SignalController): void {
  const vltPhase = ctl.phases[0]!.phase;
  agents.get(port)?.refresh();
  bus.publish(`ntcip/${ctl.id}/state`, JSON.stringify({
    crossing_id: ctl.id,
    active_phase: ctl.state.activePhase,
    color: ctl.state.color,
    elapsed_s: Math.round(ctl.state.elapsed),
    cycle: ctl.state.cycleCount,
    vlt_phase: vltPhase,
    seconds_until_vlt_green: ctl.secondsUntilGreen(vltPhase),
    granted_extension_s: ctl.state.grantedExtension,
    counters: ctl.counters,
    cross_street_debt_s: Math.round(ctl.crossStreetDebt.reduce((a, b) => a + b, 0)),
    snmp: { port, oid_active_phase: OID.prsActivePhase, oid_seconds_until_green: OID.prsSecondsUntilGreen },
  }), { qos: 0, retain: true });
}

setInterval(() => {
  for (const [port, ctl] of CONTROLLERS) {
    ctl.tick(ACCEL);
    publishState(port, ctl);
  }
}, TICK_MS);

log('info', `${CONTROLLERS.size} controladores em malha fechada (aceleracao ${ACCEL}x)`);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => { for (const a of agents.values()) a.agent.close(); bus.end(true); process.exit(0); });
}
