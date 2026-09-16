import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { Historian, migrate } from '@railsentinel/historian';
import { uuidv7, type IntrusionData, type Message, type TrainPositionData } from '@railsentinel/contracts';

/**
 * Testes do historiador contra PostgreSQL real - nao um mock de SQL.
 *
 * Um mock provaria que o codigo chama pool.query() com os argumentos certos;
 * nao provaria que o SQL e VALIDO, que os tipos de coluna aceitam os valores
 * enviados, ou que ON CONFLICT DO NOTHING de fato deduplica. Essas sao
 * exatamente as classes de erro que interessam aqui.
 *
 * Ambiente sem Postgres acessivel: os testes sao pulados com motivo explicito,
 * nao falham - a suite inteira precisa continuar rodando em uma maquina que
 * nunca configurou o banco.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://railsentinel:railsentinel_dev@127.0.0.1:5432/railsentinel_test';

let pool: pg.Pool | null = null;
let historian: Historian;
let skipReason: string | null = null;

before(async () => {
  const candidate = new pg.Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 2000 });
  try {
    await candidate.query('SELECT 1');
    await migrate(candidate);
    pool = candidate;
    historian = new Historian(pool);
  } catch (err) {
    skipReason = `Postgres indisponivel em ${DATABASE_URL}: ${(err as Error).message}`;
    await candidate.end().catch(() => {});
  }
});

after(async () => {
  await pool?.end();
});

async function truncateAll(): Promise<void> {
  if (!pool) return;
  await pool.query(`TRUNCATE telemetry_position, events_intrusion, alarms, restrictions,
                     audit_rejected, audit_safety_violations, tsp_decisions`);
}

function positionMsg(over: Partial<TrainPositionData> = {}): Message<TrainPositionData> {
  return {
    env: { v: 1, id: uuidv7(), seq: 1, boot: Date.now(), ts: new Date().toISOString(), src: 'train:tramlink:FLEET-GW', site: 'santos', line: 'L2', zone: 'FROTA', type: 'vlt.train.position.v1', class: 'sil2', sev: 'info' },
    data: { train_id: 'VLT-07', section_id: 'L2-S11', speed_kmh: 25, schedule_dev_s: 95, ...over },
  };
}

function intrusionMsg(over: Partial<IntrusionData> = {}): Message<IntrusionData> {
  return {
    env: { v: 1, id: uuidv7(), seq: 1, boot: Date.now(), ts: new Date().toISOString(), src: 'edge:jetson:XC-ANA-COSTA-01', site: 'santos', line: 'L2', zone: 'XC-ANA-COSTA', type: 'vlt.edge.intrusion.v1', class: 'basic', sev: 'critical' },
    data: {
      event: 'gauge_intrusion', state: 'onset', object: { class: 'car', conf: 0.94 },
      track: { section_id: 'L2-S11', gauge_margin_m: -0.35 },
      detector: { model: 'railguard-yolo', model_version: '3.2.1', infer_ms: 11 },
      ...over,
    },
  };
}

/**
 * Skip em runtime, nao via opcao 'skip' do describe.
 *
 * describe(nome, { skip: fn }, corpo) NAO chama fn condicionalmente - 'skip'
 * so aceita boolean|string, e uma referencia de funcao e sempre truthy. Isso
 * pulava a suite INCONDICIONALMENTE, mesmo com Postgres disponivel, e passou
 * despercebido porque o teste "ambiente sem Postgres" (pensado como sentinela
 * negativa) so verifica o caminho SEM banco - nunca provou que o caminho COM
 * banco de fato rodava. Corrigido: cada teste chama t.skip() explicitamente,
 * documentado, que e a forma suportada de pular em runtime.
 */
function skipIfNoDb(t: { skip: (msg?: string) => void }): boolean {
  if (skipReason) { t.skip(skipReason); return true; }
  return false;
}

describe('Historian - persistencia real (PostgreSQL)', () => {
  test('grava telemetria de posicao', async (t) => {
    if (skipIfNoDb(t)) return;
    await truncateAll();
    const msg = positionMsg();
    await historian.recordPosition(msg);
    const r = await pool!.query('SELECT * FROM telemetry_position WHERE envelope_id = $1', [msg.env.id]);
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0].train_id, 'VLT-07');
    assert.equal(Number(r.rows[0].speed_kmh), 25);
  });

  test('escrita e idempotente - reentrega de QoS 1 nao duplica', async (t) => {
    if (skipIfNoDb(t)) return;
    await truncateAll();
    const msg = positionMsg();
    await historian.recordPosition(msg);
    await historian.recordPosition(msg); // mesma mensagem, reentregue
    await historian.recordPosition(msg);
    const r = await pool!.query('SELECT count(*) FROM telemetry_position WHERE envelope_id = $1', [msg.env.id]);
    assert.equal(Number(r.rows[0].count), 1, 'a mesma mensagem reentregue 3x deve gravar 1 linha');
  });

  test('grava intrusao e permite reconstruir a timeline do incidente', async (t) => {
    if (skipIfNoDb(t)) return;
    await truncateAll();
    const m1 = intrusionMsg({ state: 'onset' });
    const m2 = intrusionMsg({ state: 'sustained' });
    await historian.recordIntrusion(m1, 'INC-teste');
    await historian.recordIntrusion(m2, 'INC-teste');
    const timeline = await historian.incidentTimeline('INC-teste');
    assert.equal(timeline.length, 2);
    assert.equal(timeline[0]!.state, 'onset');
    assert.equal(timeline[1]!.state, 'sustained');
  });

  test('grava alarme e permite reconhecimento com auditoria de quem e quando', async (t) => {
    if (skipIfNoDb(t)) return;
    await truncateAll();
    await historian.recordAlarm({
      alarm_id: 'AL-1', severity: 'critical', title: 'Invasao', detail: 'x', raised_at: new Date().toISOString(),
      acknowledged: false, provenance: { integrity_class: 'basic', source: 'edge:jetson:X-01', confidence: 0.9 }, actions: [],
    });
    await historian.acknowledgeAlarm('AL-1', 'operador-42');
    const r = await pool!.query('SELECT acknowledged, acknowledged_by FROM alarms WHERE alarm_id = $1', ['AL-1']);
    assert.equal(r.rows[0].acknowledged, true);
    assert.equal(r.rows[0].acknowledged_by, 'operador-42');
  });

  test('restricao e liberacao ficam auditadas com quem liberou', async (t) => {
    if (skipIfNoDb(t)) return;
    await truncateAll();
    await historian.recordRestriction({
      restriction_id: 'TSR-1', section_id: 'L2-S11', kind: 'advisory_hold', reason: 'x', origin_class: 'basic',
      issued_at: new Date().toISOString(), expires_at: new Date(Date.now() + 60_000).toISOString(),
      requires_operator_ack: true, source_event_id: uuidv7(),
    });
    await historian.clearRestriction('L2-S11', 'operador-7');
    const r = await pool!.query('SELECT cleared_at, cleared_by FROM restrictions WHERE restriction_id = $1', ['TSR-1']);
    assert.ok(r.rows[0].cleared_at);
    assert.equal(r.rows[0].cleared_by, 'operador-7');
  });

  test('violacao de particao EN 50716 e gravada e consultavel por intervalo', async (t) => {
    if (skipIfNoDb(t)) return;
    await truncateAll();
    const now = new Date();
    await historian.recordSafetyViolation({
      at: now.toISOString(), effect: 'command_emergency_brake', evidence_class: 'basic',
      required_class: 'sil4', source_event_id: 'evt-1', rationale: 'teste',
    });
    const violations = await historian.safetyViolationsSince(new Date(now.getTime() - 1000));
    assert.equal(violations.length, 1);
    assert.equal(violations[0]!.effect, 'command_emergency_brake');

    const none = await historian.safetyViolationsSince(new Date(now.getTime() + 60_000));
    assert.equal(none.length, 0, 'janela no futuro nao deve trazer nada');
  });

  test('recusas de fronteira sao agregadas por estagio', async (t) => {
    if (skipIfNoDb(t)) return;
    await truncateAll();
    const now = new Date();
    await historian.recordRejection({ at: now.toISOString(), stage: 'bad_signature', detail: 'x', topic: 't' });
    await historian.recordRejection({ at: now.toISOString(), stage: 'bad_signature', detail: 'x', topic: 't' });
    await historian.recordRejection({ at: now.toISOString(), stage: 'replay', detail: 'x', topic: 't' });
    const agg = await historian.rejectionsByStage(new Date(now.getTime() - 1000));
    const byStage = Object.fromEntries(agg.map((a) => [a.stage, Number(a.count)]));
    assert.equal(byStage.bad_signature, 2);
    assert.equal(byStage.replay, 1);
  });

  test('taxa de atendimento do TSP e calculada a partir do desfecho real', async (t) => {
    if (skipIfNoDb(t)) return;
    await truncateAll();
    const now = new Date();
    const base = { train_id: 'VLT-07', action: 'request_grant' as const, reason: 'x', decided_at: now.toISOString() };
    await historian.recordTspDecision({ ...base, crossing_id: 'XC-A' });
    await historian.updateTspOutcome('XC-A', true, 'ok');
    await historian.recordTspDecision({ ...base, crossing_id: 'XC-A' });
    await historian.updateTspOutcome('XC-A', false, 'verde maximo atingido');
    const rate = await historian.tspGrantRate(new Date(now.getTime() - 1000));
    assert.equal(rate.total, 2);
    assert.equal(rate.granted, 1);
    assert.equal(rate.rate, 0.5);
  });

  test('updateTspOutcome so atualiza o pedido SEM desfecho mais recente', async (t) => {
    if (skipIfNoDb(t)) return;
    await truncateAll();
    const now = new Date();
    await historian.recordTspDecision({ crossing_id: 'XC-A', train_id: 'VLT-07', action: 'request_grant', reason: 'r1', decided_at: new Date(now.getTime() - 2000).toISOString() });
    await historian.updateTspOutcome('XC-A', true, 'primeiro');
    await historian.recordTspDecision({ crossing_id: 'XC-A', train_id: 'VLT-12', action: 'request_grant', reason: 'r2', decided_at: now.toISOString() });
    await historian.updateTspOutcome('XC-A', false, 'segundo');

    const r = await pool!.query('SELECT reason, granted, grant_reason FROM tsp_decisions WHERE crossing_id = $1 ORDER BY decided_at', ['XC-A']);
    assert.equal(r.rows[0].reason, 'r1'); assert.equal(r.rows[0].granted, true);
    assert.equal(r.rows[1].reason, 'r2'); assert.equal(r.rows[1].granted, false);
  });
});

describe('Historian - ambiente sem Postgres', () => {
  test('a ausencia de Postgres e reportada, nao mascarada', () => {
    if (!skipReason) return; // Postgres disponivel neste ambiente - nada a provar aqui
    assert.match(skipReason, /Postgres indisponivel/);
  });
});
