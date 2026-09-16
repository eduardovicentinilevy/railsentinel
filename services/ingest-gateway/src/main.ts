import mqtt from 'mqtt';
import { existsSync, readFileSync } from 'node:fs';
import { CORE, FIELD_SUBSCRIPTIONS, type Message } from '@railsentinel/contracts';
import { DeviceRegistry } from './registry.js';
import { AdmissionPipeline, type Verdict } from './pipeline.js';
import { Downlink } from './downlink.js';

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

/**
 * mTLS no broker de CAMPO quando a PKI esta provisionada (Fase 2).
 *
 * O gateway e um dispositivo como outro qualquer do ponto de vista do broker
 * de campo: precisa do proprio certificado (emitido em npm run setup-pki) para
 * se autenticar. Isto e autenticacao de TRANSPORTE (o salto ate o broker); a
 * verificacao de assinatura Ed25519 em pipeline.ts continua autenticando cada
 * MENSAGEM individualmente, mesmo que o broker de campo seja comprometido.
 *
 * Sem PKI (bancada da Fase 1), o gateway cai para TCP simples na porta 1883 -
 * o mesmo comportamento de sempre, preservado para nao quebrar quem ainda nao
 * rodou o bootstrap.
 */
const PKI_DIR = process.env.PKI_DIR ?? '.secrets/pki';
const GATEWAY_CERT_BASENAME = 'gw_core_INGEST-GATEWAY';
const hasMtls = existsSync(`${PKI_DIR}/chain.pem`) && existsSync(`${PKI_DIR}/${GATEWAY_CERT_BASENAME}.crt.pem`);

const FIELD_URL = process.env.FIELD_BROKER_URL ?? (hasMtls ? 'mqtts://127.0.0.1:8883' : 'mqtt://127.0.0.1:1883');
const fieldTlsOptions = hasMtls
  ? {
      ca: readFileSync(`${PKI_DIR}/chain.pem`),
      cert: readFileSync(`${PKI_DIR}/${GATEWAY_CERT_BASENAME}.crt.pem`),
      key: readFileSync(`${PKI_DIR}/${GATEWAY_CERT_BASENAME}.key.pem`),
      rejectUnauthorized: true,
      servername: 'localhost',
    }
  : {};
const CORE_URL = process.env.CORE_BROKER_URL ?? 'mqtt://127.0.0.1:1884';
const REGISTRY_PATH = process.env.DEVICE_REGISTRY ?? '.secrets/devices.json';
const REQUIRE_SIG = process.env.REQUIRE_SIGNATURE !== 'false';
const CCO_KEY_PATH = process.env.CCO_KEY ?? '.secrets/cco-key.json';

const log = (lvl: string, msg: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), svc: 'ingest-gateway', lvl, msg, ...extra }));

const registry = DeviceRegistry.fromFile(REGISTRY_PATH);
const pipeline = new AdmissionPipeline(registry, { requireSignature: REQUIRE_SIG });

const downlink = new Downlink(JSON.parse(readFileSync(CCO_KEY_PATH, 'utf8')));

log('info', 'trust store carregado', { devices: registry.size, requireSignature: REQUIRE_SIG });
log('info', hasMtls ? 'mTLS ativo no broker de campo' : 'mTLS INATIVO - TCP simples (rode: npm run setup-pki)', { url: FIELD_URL });

const field = mqtt.connect(FIELD_URL, { clientId: 'gw-core-INGEST-GATEWAY', clean: true, reconnectPeriod: 1000, ...fieldTlsOptions });
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

core.on('connect', () => {
  log('info', 'conectado ao barramento do NUCLEO (zona de integracao)', { url: CORE_URL });
  // Conduite descendente: o gateway tambem e a unica saida do nucleo para o campo.
  core.subscribe('core/cmd/train/+/regulation', { qos: 1 });
  log('info', 'conduite descendente ativo', { topic: 'core/cmd/train/+/regulation' });
});

/** Estatisticas do sentido descendente, separadas do ascendente. */
const downStats = { sent: 0 };

core.on('message', (topic, payload) => {
  const m = /^core\/cmd\/train\/([^/]+)\/regulation$/.exec(topic);
  if (!m) return;
  const trainId = m[1]!;

  let cmd: Record<string, unknown>;
  try { cmd = JSON.parse(payload.toString('utf8')); } catch { return; }

  // O gateway nao reinterpreta a decisao do ATS; apenas a empacota, assina e
  // entrega no subtopico de comando que a ACL do dispositivo permite ouvir.
  const signed = downlink.build({
    type: 'vlt.train.regulation.v1',
    data: {
      train_id: trainId,
      dwell_s: cmd.dwell_s,
      coast_pct: cmd.coast_pct,
      headway_error_s: cmd.headway_error_s,
      setpoint_s: cmd.setpoint_s,
      rationale: cmd.rationale,
    },
    line: (cmd.line as 'L1' | 'L2') ?? 'L2',
    zone: 'FROTA',
    // Regulacao de headway e funcao de Integridade Basica. O carimbo desce com
    // o comando para que o computador de bordo saiba que e aconselhamento.
    integrityClass: 'basic',
  });

  const fieldTopic = Downlink.topicFor((cmd.line as string) ?? 'L2', 'FROTA', 'train', 'FLEET-GW', 'regulation');
  field.publish(fieldTopic, JSON.stringify(signed), { qos: 1 });
  downStats.sent += 1;
  log('info', 'comando de regulacao entregue ao campo', {
    train: trainId, dwell_s: cmd.dwell_s, coast_pct: cmd.coast_pct, topic: fieldTopic,
  });
});
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
    downlink_sent: downStats.sent,
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
