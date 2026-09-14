import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { AdmissionPipeline } from '@railsentinel/ingest-gateway/dist/pipeline.js';
import { DeviceRegistry, type DeviceRecord } from '@railsentinel/ingest-gateway/dist/registry.js';
import { generateEd25519, signMessage, uuidv7, type Message } from '@railsentinel/contracts';

/**
 * Testes do conduite IEC 62443: o que a fronteira deixa entrar na Zona de
 * Integracao Operacional, e - mais importante - o que ela recusa.
 */

const BOOT = Date.now();
const EDGE_KEYS = generateEd25519();
const TRAIN_KEYS = generateEd25519();

function registry(over: Partial<DeviceRecord> = {}): DeviceRegistry {
  const reg = new DeviceRegistry();
  reg.add({
    src: 'edge:jetson:XC-ANA-COSTA-01', kid: 'XC-ANA-COSTA-01:2026-09',
    publicKeyPem: EDGE_KEYS.publicKeyPem,
    allowedZones: ['XC-ANA-COSTA'],
    allowedTypes: ['vlt.edge.intrusion.v1', 'vlt.edge.health.v1'],
    maxIntegrityClass: 'basic',
    status: 'active', enrolled_at: new Date().toISOString(),
    ...over,
  });
  reg.add({
    src: 'train:tramlink:FLEET-GW', kid: 'FLEET-GW:2026-09',
    publicKeyPem: TRAIN_KEYS.publicKeyPem,
    allowedZones: ['FROTA'], allowedTypes: ['vlt.train.position.v1'],
    maxIntegrityClass: 'sil2',
    status: 'active', enrolled_at: new Date().toISOString(),
  });
  return reg;
}

let seq = 0;
function signed(envOver: Partial<Message['env']> = {}, dataOver: any = null, keys = EDGE_KEYS, kid = 'XC-ANA-COSTA-01:2026-09'): Buffer {
  const msg: Message = {
    env: {
      v: 1, id: uuidv7(), seq: ++seq, boot: BOOT, ts: new Date().toISOString(),
      src: 'edge:jetson:XC-ANA-COSTA-01', site: 'santos', line: 'L2', zone: 'XC-ANA-COSTA',
      type: 'vlt.edge.intrusion.v1', class: 'basic', sev: 'critical', ...envOver,
    },
    data: dataOver ?? {
      event: 'gauge_intrusion', state: 'onset',
      object: { class: 'car', conf: 0.94 },
      track: { section_id: 'L2-S11', gauge_margin_m: -0.35 },
      detector: { model: 'railguard-yolo', model_version: '3.2.1', infer_ms: 11.4 },
      dwell_ms: 2400,
    },
  };
  msg.sig = signMessage(msg, keys.privateKeyPem, kid);
  return Buffer.from(JSON.stringify(msg));
}

const TOPIC = 'vlt/santos/L2/XC-ANA-COSTA/edge/XC-ANA-COSTA-01/evt/intrusion';

describe('AdmissionPipeline - fronteira IEC 62443', () => {
  test('mensagem legitima e admitida', () => {
    const p = new AdmissionPipeline(registry());
    const v = p.admit(TOPIC, signed());
    assert.equal(v.ok, true, v.ok ? '' : `${v.stage}: ${v.detail}`);
  });

  test('payload acima do limite e recusado sem parse', () => {
    const p = new AdmissionPipeline(registry(), { maxBytes: 100 });
    const v = p.admit(TOPIC, signed());
    assert.equal(v.ok, false);
    assert.equal((v as any).stage, 'oversize');
  });

  test('JSON malformado e recusado', () => {
    const p = new AdmissionPipeline(registry());
    const v = p.admit(TOPIC, Buffer.from('{"env":'));
    assert.equal((v as any).stage, 'malformed_json');
  });

  test('mensagem sem assinatura e recusada', () => {
    const p = new AdmissionPipeline(registry());
    const raw = JSON.parse(signed().toString());
    delete raw.sig;
    const v = p.admit(TOPIC, Buffer.from(JSON.stringify(raw)));
    assert.equal((v as any).stage, 'missing_signature');
  });

  test('payload adulterado apos a assinatura e recusado', () => {
    const p = new AdmissionPipeline(registry());
    const raw = JSON.parse(signed().toString());
    raw.data.object.conf = 0.99;
    const v = p.admit(TOPIC, Buffer.from(JSON.stringify(raw)));
    assert.equal((v as any).stage, 'bad_signature');
  });

  test('publicacao no subtopico de outro no e recusada', () => {
    const p = new AdmissionPipeline(registry());
    const v = p.admit('vlt/santos/L2/XC-JOAO-PESSOA/edge/XC-JOAO-PESSOA-01/evt/intrusion', signed());
    assert.equal((v as any).stage, 'src_topic_mismatch');
  });

  test('dispositivo nao matriculado e recusado', () => {
    const p = new AdmissionPipeline(registry());
    const v = p.admit('vlt/santos/L2/XC-ANA-COSTA/edge/DESCONHECIDO/evt/intrusion',
      signed({ src: 'edge:jetson:DESCONHECIDO' }));
    assert.equal((v as any).stage, 'unknown_device');
  });

  test('dispositivo revogado e recusado', () => {
    const p = new AdmissionPipeline(registry({ status: 'revoked' }));
    const v = p.admit(TOPIC, signed());
    assert.equal((v as any).stage, 'revoked_device');
  });

  test('zona fora da permissao e recusada', () => {
    const p = new AdmissionPipeline(registry({ allowedZones: ['OUTRA-ZONA'] }));
    const v = p.admit(TOPIC, signed());
    assert.equal((v as any).stage, 'zone_not_allowed');
  });

  test('tipo fora da permissao e recusado', () => {
    const p = new AdmissionPipeline(registry({ allowedTypes: ['vlt.edge.health.v1'] }));
    const v = p.admit(TOPIC, signed());
    assert.equal((v as any).stage, 'type_not_allowed');
  });

  // O controle central: a classe EN 50716 e autodeclarada, entao precisa ser
  // conferida contra a homologacao do dispositivo.
  test('no de visao NAO pode reivindicar classe SIL4', () => {
    const p = new AdmissionPipeline(registry());
    const v = p.admit(TOPIC, signed({ class: 'sil4' }));
    assert.equal(v.ok, false);
    assert.equal((v as any).stage, 'integrity_class_not_allowed');
    assert.match((v as any).detail, /homologado ate 'basic'/);
  });

  test('no de visao NAO pode reivindicar classe SIL2', () => {
    const p = new AdmissionPipeline(registry());
    const v = p.admit(TOPIC, signed({ class: 'sil2' }));
    assert.equal((v as any).stage, 'integrity_class_not_allowed');
  });

  test('gateway de bordo PODE reivindicar SIL2 (esta homologado)', () => {
    const p = new AdmissionPipeline(registry());
    const buf = signed({
      src: 'train:tramlink:FLEET-GW', zone: 'FROTA', type: 'vlt.train.position.v1', class: 'sil2', sev: 'info',
    }, { train_id: 'VLT-07', section_id: 'L2-S11', speed_kmh: 25, schedule_dev_s: 95 }, TRAIN_KEYS, 'FLEET-GW:2026-09');
    const v = p.admit('vlt/santos/L2/FROTA/train/FLEET-GW/tlm/position', buf);
    assert.equal(v.ok, true, v.ok ? '' : `${v.stage}: ${v.detail}`);
  });

  test('gateway de bordo NAO pode reivindicar SIL4', () => {
    const p = new AdmissionPipeline(registry());
    const buf = signed({
      src: 'train:tramlink:FLEET-GW', zone: 'FROTA', type: 'vlt.train.position.v1', class: 'sil4', sev: 'info',
    }, { train_id: 'VLT-07', section_id: 'L2-S11', speed_kmh: 25 }, TRAIN_KEYS, 'FLEET-GW:2026-09');
    const v = p.admit('vlt/santos/L2/FROTA/train/FLEET-GW/tlm/position', buf);
    assert.equal((v as any).stage, 'integrity_class_not_allowed');
  });

  test('kid de outro dispositivo e recusado', () => {
    const p = new AdmissionPipeline(registry());
    const v = p.admit(TOPIC, signed({}, null, EDGE_KEYS, 'FLEET-GW:2026-09'));
    assert.equal((v as any).stage, 'bad_signature');
  });

  test('duplicata exata e recusada', () => {
    const p = new AdmissionPipeline(registry());
    const buf = signed();
    assert.equal(p.admit(TOPIC, buf).ok, true);
    const v = p.admit(TOPIC, buf);
    assert.equal((v as any).stage, 'replay');
    assert.match((v as any).detail, /duplicate/);
  });

  test('limite de taxa por dispositivo e aplicado', () => {
    const p = new AdmissionPipeline(registry(), { rateLimitPerSec: 3 });
    const now = Date.now();
    let limited = 0;
    for (let i = 0; i < 8; i++) {
      const v = p.admit(TOPIC, signed(), now);
      if (!v.ok && v.stage === 'rate_limited') limited += 1;
    }
    assert.ok(limited >= 4, `esperado bloqueio por taxa, obtido ${limited}`);
  });

  test('ordem do pipeline: schema barra antes da criptografia', () => {
    // 'data' invalido com assinatura correta: deve morrer no schema, nao na
    // verificacao - prova que nao se gasta Ed25519 em lixo bem assinado.
    const p = new AdmissionPipeline(registry());
    const v = p.admit(TOPIC, signed({}, { event: 'invalido_total' }));
    assert.equal((v as any).stage, 'schema');
  });
});
