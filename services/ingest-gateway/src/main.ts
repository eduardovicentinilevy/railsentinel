import mqtt from 'mqtt';
import { CORE, FIELD_SUBSCRIPTIONS, type Message } from '@railsentinel/contracts';
import { DeviceRegistry } from './registry.js';
import { AdmissionPipeline, type Verdict } from './pipeline.js';

/**
 * ingest-gateway - o conduite IEC 62443 entre a Zona Periferica (campo) e a
 * Zona de Integracao Operacional (nucleo do CCO).
 *
 * Este e deliberadamente o UNICO processo com conexao aos dois brokers. Nenhum
 * servico do nucleo fala com o campo; nenhum no de campo alcanca o nucleo. Toda
 * mensagem que cruza a fronteira passa pelo pipeline de admissao, e o que cruza
 * ja vem validado, autenticado, fresco e normalizado. Servicos a jusante
 * (ats-core, operator-api) podem entao confiar na forma do dado sem repetir
 * verificacao - a fronteira e um lugar so, auditavel em um lugar so.
 */

const FIELD_URL = process.env.FIELD_BROKER_URL ?? 'mqtt://127.0.0.1:1883';
const CORE_URL = process.env.CORE_BROKER_URL ?? 'mqtt://127.0.0.1:1884';
const REGISTRY_PATH = process.env.DEVICE_REGISTRY ?? '.secrets/devices.json';
const REQUIRE_SIG = process.env.REQUIRE_SIGNATURE !== 'false';

const log = (lvl: string, msg: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), svc: 'ingest-gateway', lvl, msg, ...extra }));

const registry = DeviceRegistry.fromFile(REGISTRY_PATH);
const pipeline = new AdmissionPipeline(registry, { requireSignature: REQUIRE_SIG });

log('info', 'trust store carregado', { devices: registry.size, requireSignature: REQUIRE_SIG });

const field = mqtt.connect(FIELD_URL, { clientId: 'gw-field', clean: true, reconnectPeriod: 1000 });
const core = mqtt.connect(CORE_URL, { clientId: 'gw-core', clean: true, reconnectPeriod: 1000 });

const stats = { accepted: 0, rejected: 0, byStage: new Map<string, number>() };

field.on('connect', () => {
  log('info', 'conectado ao broker de CAMPO (zona periferica)', { url: FIELD_URL });
  for (const t of FIELD_SUBSCRIPTIONS) {
    field.subscribe(t, { qos: 1 }, (err) => {
      if (err) log('error', 'falha ao assinar', { topic: t, err: err.message });
      else log('info', 'assinatura ativa', { topic: t });
    });
  }
});

core.on('connect', () => log('info', 'conectado ao barramento do NUCLEO (zona de integracao)', { url: CORE_URL }));
field.on('error', (e) => log('error', 'erro no broker de campo', { err: e.message }));
core.on('error', (e) => log('error', 'erro no barramento do nucleo', { err: e.message }));

/** Onde cada tipo de campo desemboca no barramento interno. */
const ROUTES: Record<string, string> = {
  'vlt.edge.intrusion.v1': CORE.normalizedIntrusion,
  'vlt.edge.health.v1': CORE.normalizedHealth,
  'vlt.train.position.v1': CORE.normalizedPosition,
};

field.on('message', (topic, payload) => {
  const verdict: Verdict = pipeline.admit(topic, payload);

  if (!verdict.ok) {
    stats.rejected += 1;
    stats.byStage.set(verdict.stage, (stats.byStage.get(verdict.stage) ?? 0) + 1);
    log('warn', 'mensagem recusada na fronteira', {
      stage: verdict.stage, detail: verdict.detail, topic: verdict.topic, src: verdict.src,
    });
    // Toda recusa vira trilha de auditoria. Um pico de 'bad_signature' num no e
    // sinal de comprometimento, nao ruido - o SOC precisa ver isso.
    core.publish(
      CORE.auditRejected,
      JSON.stringify({ at: new Date().toISOString(), stage: verdict.stage, detail: verdict.detail, topic: verdict.topic, src: verdict.src }),
      { qos: 1 },
    );
    return;
  }

  stats.accepted += 1;
  const msg: Message = verdict.message;

  if (verdict.gaps > 0) {
    log('warn', 'lacuna de sequencia - possivel perda de pacote no radio', { src: msg.env.src, gaps: verdict.gaps });
  }
  if (verdict.rebooted) {
    log('info', 'origem reiniciou - nova sessao de boot', { src: msg.env.src, boot: msg.env.boot });
  }

  const route = ROUTES[msg.env.type];
  if (!route) {
    log('warn', 'tipo admitido sem rota interna', { type: msg.env.type });
    return;
  }

  // Enriquecimento na fronteira: o nucleo ganha o topico de origem e o instante
  // de ingestao, para que a latencia borda->CCO seja mensuravel fim-a-fim.
  const forwarded = {
    ...msg,
    _ingest: { topic, received_at: new Date().toISOString(), latency_ms: Date.now() - Date.parse(msg.env.ts), gaps: verdict.gaps },
  };

  core.publish(route, JSON.stringify(forwarded), { qos: 1 }, (err) => {
    if (err) log('error', 'falha ao publicar no nucleo', { route, err: err.message });
  });

  if (msg.env.sev === 'critical' || msg.env.type === 'vlt.edge.intrusion.v1') {
    log('info', 'evento critico repassado ao nucleo', {
      type: msg.env.type, src: msg.env.src, zone: msg.env.zone, id: msg.env.id, route,
      latency_ms: forwarded._ingest.latency_ms,
    });
  }
});

setInterval(() => {
  log('info', 'metricas da fronteira', {
    accepted: stats.accepted, rejected: stats.rejected, byStage: Object.fromEntries(stats.byStage),
  });
}, 30_000).unref();

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    log('info', 'encerrando conduite');
    field.end(true);
    core.end(true);
    process.exit(0);
  });
}
