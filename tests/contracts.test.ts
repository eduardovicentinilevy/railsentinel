import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalize, generateEd25519, signMessage, verifyMessage, signingInput,
  validateMessage, ReplayGuard, uuidv7, buildTopic, parseTopic, publishAclFor,
  type Message,
} from '@railsentinel/contracts';

const BOOT = Date.now();

function makeMessage(over: Partial<Message['env']> = {}, data?: unknown): Message {
  return {
    env: {
      v: 1, id: uuidv7(), seq: 1, boot: BOOT, ts: new Date().toISOString(),
      src: 'edge:jetson:XC-ANA-COSTA-01', site: 'santos', line: 'L2', zone: 'XC-ANA-COSTA',
      type: 'vlt.edge.intrusion.v1', class: 'basic', sev: 'critical', ...over,
    },
    data: (data ?? {
      event: 'gauge_intrusion', state: 'onset',
      object: { class: 'car', conf: 0.94 },
      track: { section_id: 'L2-S11', gauge_margin_m: -0.35 },
      detector: { model: 'railguard-yolo', model_version: '3.2.1', infer_ms: 11.4 },
      dwell_ms: 2400,
    }) as Record<string, unknown>,
  };
}

describe('serializacao canonica', () => {
  test('ordem das chaves nao altera a saida', () => {
    assert.equal(canonicalize({ b: 1, a: 2 }), canonicalize({ a: 2, b: 1 }));
  });

  test('descarta undefined mas preserva null', () => {
    assert.equal(canonicalize({ a: undefined, b: null }), '{"b":null}');
  });

  test('recusa NaN e Infinity', () => {
    assert.throws(() => canonicalize({ x: NaN }), TypeError);
    assert.throws(() => canonicalize({ x: Infinity }), TypeError);
  });

  test('aninhamento e ordenado recursivamente', () => {
    assert.equal(canonicalize({ z: { d: 1, c: 2 }, a: [3, { y: 1, x: 2 }] }), '{"a":[3,{"x":2,"y":1}],"z":{"c":2,"d":1}}');
  });
});

describe('assinatura Ed25519', () => {
  test('mensagem integra verifica', () => {
    const { publicKeyPem, privateKeyPem } = generateEd25519();
    const msg = makeMessage();
    msg.sig = signMessage(msg, privateKeyPem, 'k1');
    assert.equal(verifyMessage(msg, publicKeyPem), true);
  });

  test('payload adulterado apos a assinatura falha', () => {
    const { publicKeyPem, privateKeyPem } = generateEd25519();
    const msg = makeMessage();
    msg.sig = signMessage(msg, privateKeyPem, 'k1');
    (msg.data as any).object.conf = 0.99;
    assert.equal(verifyMessage(msg, publicKeyPem), false);
  });

  test('envelope adulterado falha - a classe de integridade esta coberta', () => {
    const { publicKeyPem, privateKeyPem } = generateEd25519();
    const msg = makeMessage();
    msg.sig = signMessage(msg, privateKeyPem, 'k1');
    msg.env.class = 'sil4'; // tentativa de escalar autoridade
    assert.equal(verifyMessage(msg, publicKeyPem), false);
  });

  test('chave de outro dispositivo nao verifica', () => {
    const a = generateEd25519();
    const b = generateEd25519();
    const msg = makeMessage();
    msg.sig = signMessage(msg, a.privateKeyPem, 'k1');
    assert.equal(verifyMessage(msg, b.publicKeyPem), false);
  });

  test('ordem das chaves do objeto nao muda os bytes assinados', () => {
    const m1 = makeMessage();
    const m2: Message = { data: m1.data, env: { ...m1.env } };
    assert.equal(signingInput(m1).toString('hex'), signingInput(m2).toString('hex'));
  });
});

describe('validacao de schema', () => {
  test('mensagem valida passa', () => {
    assert.equal(validateMessage(makeMessage()).ok, true);
  });

  test('envelope sem boot e recusado', () => {
    const msg: any = makeMessage();
    delete msg.env.boot;
    const r = validateMessage(msg);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.includes('boot')));
  });

  test('classe de integridade fora do enum e recusada', () => {
    const msg: any = makeMessage({ class: 'sil9' as any });
    assert.equal(validateMessage(msg).ok, false);
  });

  test('ts com fuso local e recusado - so UTC com milissegundos', () => {
    const msg = makeMessage({ ts: '2026-09-14T12:00:00.000-03:00' });
    assert.equal(validateMessage(msg).ok, false);
  });

  test('confianca acima de 1 e recusada', () => {
    const msg = makeMessage({}, {
      event: 'gauge_intrusion', state: 'onset',
      object: { class: 'car', conf: 1.4 },
      track: { section_id: 'L2-S11' },
      detector: { model: 'm', model_version: '1', infer_ms: 1 },
    });
    assert.equal(validateMessage(msg).ok, false);
  });

  test('campo desconhecido em data e recusado (additionalProperties: false)', () => {
    const msg = makeMessage({}, {
      event: 'gauge_intrusion', state: 'onset',
      object: { class: 'car', conf: 0.9 },
      track: { section_id: 'L2-S11' },
      detector: { model: 'm', model_version: '1', infer_ms: 1 },
      comando_injetado: 'rm -rf /',
    });
    assert.equal(validateMessage(msg).ok, false);
  });

  test('tipo desconhecido e recusado', () => {
    assert.equal(validateMessage(makeMessage({ type: 'vlt.edge.inexistente.v1' })).ok, false);
  });
});

describe('ReplayGuard', () => {
  const ts = () => new Date().toISOString();

  test('aceita sequencia normal', () => {
    const g = new ReplayGuard();
    assert.equal(g.check({ src: 'a', id: uuidv7(), seq: 1, boot: 100, ts: ts() }).accept, true);
    assert.equal(g.check({ src: 'a', id: uuidv7(), seq: 2, boot: 100, ts: ts() }).accept, true);
  });

  test('id repetido e duplicata, nao ataque', () => {
    const g = new ReplayGuard();
    const id = uuidv7();
    g.check({ src: 'a', id, seq: 1, boot: 100, ts: ts() });
    const v = g.check({ src: 'a', id, seq: 2, boot: 100, ts: ts() });
    assert.equal(v.accept, false);
    assert.equal(v.reason, 'duplicate');
  });

  test('seq regredido na mesma sessao e replay', () => {
    const g = new ReplayGuard();
    g.check({ src: 'a', id: uuidv7(), seq: 5, boot: 100, ts: ts() });
    const v = g.check({ src: 'a', id: uuidv7(), seq: 3, boot: 100, ts: ts() });
    assert.equal(v.accept, false);
    assert.equal(v.reason, 'replayed_seq');
  });

  test('reinicio legitimo zera seq sem ser tratado como replay', () => {
    const g = new ReplayGuard();
    g.check({ src: 'a', id: uuidv7(), seq: 9, boot: 100, ts: ts() });
    const v = g.check({ src: 'a', id: uuidv7(), seq: 1, boot: 200, ts: ts() });
    assert.equal(v.accept, true, 'reboot com boot maior deve ser aceito');
    assert.equal(v.rebooted, true);
  });

  test('sessao de boot anterior e recusada', () => {
    const g = new ReplayGuard();
    g.check({ src: 'a', id: uuidv7(), seq: 1, boot: 200, ts: ts() });
    const v = g.check({ src: 'a', id: uuidv7(), seq: 99, boot: 100, ts: ts() });
    assert.equal(v.accept, false);
    assert.equal(v.reason, 'stale_boot');
  });

  test('mensagem antiga e descartada', () => {
    const g = new ReplayGuard({ maxAgeMs: 5000 });
    const old = new Date(Date.now() - 60_000).toISOString();
    const v = g.check({ src: 'a', id: uuidv7(), seq: 1, boot: 100, ts: old });
    assert.equal(v.accept, false);
    assert.equal(v.reason, 'stale');
  });

  test('relogio muito adiantado e descartado', () => {
    const g = new ReplayGuard({ maxSkewMs: 2000 });
    const future = new Date(Date.now() + 60_000).toISOString();
    const v = g.check({ src: 'a', id: uuidv7(), seq: 1, boot: 100, ts: future });
    assert.equal(v.accept, false);
    assert.equal(v.reason, 'future');
  });

  test('origens distintas nao interferem entre si', () => {
    const g = new ReplayGuard();
    g.check({ src: 'a', id: uuidv7(), seq: 50, boot: 100, ts: ts() });
    assert.equal(g.check({ src: 'b', id: uuidv7(), seq: 1, boot: 100, ts: ts() }).accept, true);
  });

  test('lacuna de sequencia e contabilizada', () => {
    const g = new ReplayGuard();
    g.check({ src: 'a', id: uuidv7(), seq: 1, boot: 100, ts: ts() });
    assert.equal(g.gapCount('a', 5, 100), 3);
  });
});

describe('topicos e ACL', () => {
  test('build e parse sao simetricos', () => {
    const parts = { site: 'santos', line: 'L2', zone: 'XC-ANA-COSTA', srcKind: 'edge' as const, srcId: 'XC-ANA-COSTA-01', stream: 'evt' as const, name: 'intrusion' };
    assert.deepEqual(parseTopic(buildTopic(parts)), parts);
  });

  test('topico fora da hierarquia vlt/ e rejeitado', () => {
    assert.equal(parseTopic('$SYS/broker/version'), null);
    assert.equal(parseTopic('vlt/santos/L2'), null);
  });

  test('ACL confina o dispositivo ao proprio subtopico', () => {
    assert.equal(publishAclFor('XC-ANA-COSTA-01'), 'vlt/+/+/+/+/XC-ANA-COSTA-01/#');
  });
});

describe('uuidv7', () => {
  test('ordena por tempo', () => {
    const a = uuidv7(1_000_000);
    const b = uuidv7(2_000_000);
    assert.ok(a < b, 'ids mais novos devem ordenar depois');
  });

  test('tem a forma do envelope schema', () => {
    assert.match(uuidv7(), /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
