import snmp from 'net-snmp';
import mqtt from 'mqtt';
import { SignalController, type PhaseConfig, type PriorityRequest } from './controller.js';
import { createAuthenticatedScalarAgent, type AuthenticatedScalarAgent } from './snmpv3-agent.js';
import { OID, COLOR_CODE } from './mib.js';

/**
 * Emulador de controlador semaforico NTCIP 1202 - agente SNMP em malha fechada.
 *
 * Este e o HIL exigido pela Fase 1. O pedido de prioridade chega por um canal
 * MQTT dedicado (nao SNMP SET - ver "Canal de comando do HIL" abaixo para o
 * motivo); o emulador aplica sobre a maquina de estados respeitando verde
 * minimo, amarelo, vermelho-geral e verde maximo; e devolve o estado real
 * tanto por MQTT quanto por SNMP GET autenticado (SNMPv3/USM, Fase 2) nos
 * OIDs reais da arvore NTCIP. A malha fecha porque o CCO le de volta o que o
 * controlador efetivamente fez - que frequentemente nao e o que ele pediu.
 *
 * Um emulador que apenas registrasse os pedidos e respondesse 'ok' provaria
 * nada. O valor esta na recusa: 'verde maximo ja atingido', 'extensao pedida
 * com a fase fora de verde'. E isso que expoe se o TSP oscila.
 *
 * SNMPv3/USM (Fase 2): a leitura de estado agora exige autenticacao -
 * community string em claro (SNMPv1/v2c) e inaceitavel para um objeto que
 * controla prioridade em cruzamento urbano. O usuario e a chave de
 * autenticacao ficam em variaveis de ambiente, nunca hardcoded; ver
 * docs/HA.md e ARQUITETURA.md 7 para o que ainda falta (SET autenticado
 * contra o controlador REAL da CET-Santos, nao apenas GET contra o emulador).
 */

const SNMP_PORT = Number(process.env.NTCIP_PORT ?? 1161);

/**
 * Credenciais SNMPv3/USM. Vem de variavel de ambiente, nunca hardcoded -
 * mesma disciplina das chaves de assinatura Ed25519 e da PKI (.secrets/).
 * Os valores padrao servem so para a bancada nao exigir configuracao extra;
 * em campo, cada implantacao provisiona a propria chave.
 */
const SNMP_USER = process.env.NTCIP_SNMP_USER ?? 'railsentinel-ats';
const SNMP_AUTH_KEY = process.env.NTCIP_SNMP_AUTH_KEY ?? 'railsentinel-auth-bancada';
const SNMP_PRIV_KEY = process.env.NTCIP_SNMP_PRIV_KEY ?? 'railsentinel-priv-bancada';
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

function makeAgent(port: number, ctl: SignalController): { agent: AuthenticatedScalarAgent; refresh: () => void } {
  const scalar = createAuthenticatedScalarAgent(
    port, Object.values(OID),
    { user: SNMP_USER, authKey: SNMP_AUTH_KEY, privKey: SNMP_PRIV_KEY },
    (err) => log('error', 'erro no agente SNMP', { controller: ctl.id, err: err.message }),
  );

  const refresh = () => {
    scalar.setValue(OID.prsActivePhase, ctl.state.activePhase);
    scalar.setValue(OID.prsActiveColor, COLOR_CODE[ctl.state.color]);
    scalar.setValue(OID.phaseStatusGroupGreens, ctl.state.color === 'green' ? ctl.state.activePhase : 0);
    scalar.setValue(OID.phaseStatusGroupYellows, ctl.state.color === 'yellow' ? ctl.state.activePhase : 0);
    scalar.setValue(OID.phaseStatusGroupReds, ctl.state.color === 'all_red' ? ctl.state.activePhase : 0);
    const vlt = ctl.phases[0]!.phase;
    scalar.setValue(OID.prsSecondsUntilGreen, ctl.secondsUntilGreen(vlt));
  };
  refresh();

  return { agent: scalar, refresh };
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
