import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  ccoReducer,
  initialState,
  HOLD_MARGIN,
  MIN_GAP,
  TRAIN_SPEED,
} from '../apps/cco-dashboard/src/state/reducer.ts';
import { forward, isInside, wrap } from '../apps/cco-dashboard/src/domain/line.ts';
import { tspServiceRate } from '../apps/cco-dashboard/src/state/selectors.ts';
import type { CcoAction, CcoState } from '../apps/cco-dashboard/src/state/types.ts';

/**
 * Regras do painel do CCO (apps/cco-dashboard) que têm semântica de
 * segurança operacional, mesmo sobre dados mockados: uma restrição de via
 * nunca é liberada sem a matrícula do operador do posto, e a simulação
 * nunca deixa uma composição entrar numa seção restrita ativa.
 */

const NOW = new Date('2026-09-28T14:30:00');
const AT = '14:30:00';

function run(state: CcoState, actions: CcoAction[]): CcoState {
  return actions.reduce(ccoReducer, state);
}

function ticks(state: CcoState, n: number, dtSec: number): CcoState {
  let s = state;
  for (let i = 0; i < n; i++) s = ccoReducer(s, { type: 'TICK', dtSec, at: AT });
  return s;
}

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object') {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

describe('estado inicial', () => {
  test('instantâneo coerente com o cenário do projeto', () => {
    const s = initialState(NOW);
    assert.equal(s.operator, 'OP-4471');
    assert.equal(s.operatorSince, '14:05:00');
    assert.deepEqual(s.trains.map((t) => t.id), ['VLT-07', 'VLT-12', 'VLT-19']);
    assert.equal(s.restrictions.length, 1);
    assert.equal(s.restrictions[0].id, 'TSR-08fe2b');
    assert.deepEqual(s.restrictions[0].range, [0.02, 0.16]);
    assert.equal(s.alarms.every((a) => a.ack === null), true);
  });

  test('horários mockados são relativos ao carregamento', () => {
    const s = initialState(NOW);
    assert.equal(s.alarms.find((a) => a.id === 'INC-a91f3c')?.raisedAt, '14:22:50');
  });

  test('registro vem do mais recente para o mais antigo', () => {
    const s = initialState(NOW);
    const seqs = s.log.map((e) => e.seq);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => b - a));
    assert.equal(s.nextSeq, Math.max(...seqs) + 1);
  });

  test('taxa de atendimento TSP = concedidas / (concedidas + recusadas)', () => {
    assert.equal(tspServiceRate(initialState(NOW)), 2 / 3);
  });
});

describe('liberação de restrição (confirmação dupla)', () => {
  const clear = (confirmOperator: string): CcoAction => ({
    type: 'RESTRICTION_CLEAR',
    restrictionId: 'TSR-08fe2b',
    confirmOperator,
    cctvVerified: true,
    at: AT,
  });

  test('matrícula diferente da do posto não libera', () => {
    const s = run(initialState(NOW), [clear('OP-9999')]);
    assert.equal(s.restrictions[0].cleared, null);
  });

  test('sem a verificação do CFTV não libera, mesmo com a matrícula certa', () => {
    const s = run(initialState(NOW), [{ ...clear('OP-4471'), cctvVerified: false } as CcoAction]);
    assert.equal(s.restrictions[0].cleared, null);
  });

  test('matrícula vazia não libera', () => {
    const s = run(initialState(NOW), [clear('   ')]);
    assert.equal(s.restrictions[0].cleared, null);
  });

  test('sem operador no posto, nada é liberado — nem com a matrícula antiga', () => {
    const s = run(initialState(NOW), [{ type: 'LOGOUT', at: AT }, clear('OP-4471')]);
    assert.equal(s.restrictions[0].cleared, null);
  });

  test('matrícula do posto libera, normalizada, e fica registrada', () => {
    const before = initialState(NOW);
    const s = run(before, [clear('  op-4471 ')]);
    assert.deepEqual(s.restrictions[0].cleared, { by: 'OP-4471', at: AT });
    assert.equal(s.log[0].kind, 'clear');
    assert.equal(s.log[0].operator, 'OP-4471');
    assert.equal(s.log.length, before.log.length + 1);
  });

  test('liberar de novo é no-op (nada é reescrito nem duplicado no registro)', () => {
    const once = run(initialState(NOW), [clear('OP-4471')]);
    const twice = ccoReducer(once, { ...clear('OP-4471'), at: '15:00:00' } as CcoAction);
    assert.equal(twice, once);
  });
});

describe('alarmes', () => {
  test('reconhecimento atribui operador e horário', () => {
    const s = run(initialState(NOW), [{ type: 'ALARM_ACK', alarmId: 'INC-a91f3c', at: AT }]);
    assert.deepEqual(s.alarms.find((a) => a.id === 'INC-a91f3c')?.ack, { by: 'OP-4471', at: AT });
    assert.equal(s.log[0].kind, 'ack');
  });

  test('reconhecer exige operador no posto', () => {
    const s = run(initialState(NOW), [{ type: 'LOGOUT', at: AT }, { type: 'ALARM_ACK', alarmId: 'INC-a91f3c', at: AT }]);
    assert.equal(s.alarms.every((a) => a.ack === null), true);
  });

  test('ação só é aceita se estiver entre as ações previstas do alarme', () => {
    const base = initialState(NOW);
    const ok = run(base, [{ type: 'ALARM_ACTION', alarmId: 'INC-a91f3c', label: 'Acionar CFTV do trecho', at: AT }]);
    const forged = run(base, [{ type: 'ALARM_ACTION', alarmId: 'INC-a91f3c', label: 'Liberar via', at: AT }]);
    assert.equal(ok.log.length, base.log.length + 1);
    assert.equal(forged, base);
  });
});

describe('aviso de regulação (advisory)', () => {
  const advise = (trainId: string): CcoAction => ({ type: 'REGULATION_ADVICE', trainId, at: AT });

  test('composição adiantada recebe aviso de retenção na próxima parada', () => {
    const s = run(initialState(NOW), [advise('VLT-12')]);
    assert.equal(s.log[0].text, 'Aviso de regulação ao VLT-12: reter 40 s em João Pessoa');
    assert.equal(s.log[0].operator, 'OP-4471');
  });

  test('composição atrasada nunca é retida', () => {
    const base = initialState(NOW);
    assert.equal(run(base, [advise('VLT-07')]), base);
  });

  test('composição em tabela não recebe aviso', () => {
    const base = initialState(NOW);
    assert.equal(run(base, [advise('VLT-19')]), base);
  });

  test('aviso exige operador no posto', () => {
    const s = run(initialState(NOW), [{ type: 'LOGOUT', at: AT }, advise('VLT-12')]);
    assert.equal(s.log.some((e) => e.text.startsWith('Aviso de regulação')), false);
  });
});

describe('sessão do posto', () => {
  test('matrícula inválida não assume o posto', () => {
    const s = run(initialState(NOW), [{ type: 'LOGOUT', at: AT }, { type: 'LOGIN', operator: 'x; drop', at: AT }]);
    assert.equal(s.operator, null);
  });

  test('não é possível assumir um posto ocupado', () => {
    const s = run(initialState(NOW), [{ type: 'LOGIN', operator: 'OP-0001', at: AT }]);
    assert.equal(s.operator, 'OP-4471');
  });

  test('troca de turno registra saída e entrada', () => {
    const s = run(initialState(NOW), [
      { type: 'LOGOUT', at: AT },
      { type: 'LOGIN', operator: 'op-0001', at: AT },
    ]);
    assert.equal(s.operator, 'OP-0001');
    assert.equal(s.operatorSince, AT);
    assert.deepEqual(s.log.slice(0, 2).map((e) => e.text), ['Operador OP-0001 assumiu o posto', 'Operador OP-4471 deixou o posto']);
  });
});

describe('simulação da linha', () => {
  test('composição para antes de uma seção restrita ativa e acumula atraso', () => {
    // 10x por 60 s de simulação: VLT-19 (t=0.81) percorre >0.198 do loop e chega ao ponto de parada
    const s = ticks(initialState(NOW), 60, 10);
    const vlt19 = s.trains.find((t) => t.id === 'VLT-19')!;
    assert.equal(vlt19.t, wrap(0.02 - HOLD_MARGIN));
    assert.deepEqual(vlt19.hold, { kind: 'restriction', restrictionId: 'TSR-08fe2b', sectionId: 'L2-S11' });
    assert.ok(vlt19.dev > 12 + 200, `atraso deveria crescer parado; dev=${vlt19.dev}`);
    assert.ok(s.log.some((e) => e.text.startsWith('VLT-19 parado antes de L2-S11')));
  });

  test('nenhuma composição entra na seção restrita enquanto ela estiver ativa (loop longo, passo grande)', () => {
    let s = initialState(NOW);
    const range = s.restrictions[0].range;
    const entered = new Set(s.trains.filter((t) => isInside(t.t, range)).map((t) => t.id));
    for (let i = 0; i < 3000; i++) {
      s = ccoReducer(s, { type: 'TICK', dtSec: 10, at: AT });
      for (const t of s.trains) {
        if (!entered.has(t.id)) assert.equal(isInside(t.t, range), false, `${t.id} entrou em L2-S11 no tick ${i}`);
      }
    }
  });

  test('distância mínima entre composições é mantida', () => {
    let s = initialState(NOW);
    for (let i = 0; i < 3000; i++) {
      s = ccoReducer(s, { type: 'TICK', dtSec: 10, at: AT });
      for (const a of s.trains) {
        for (const b of s.trains) {
          if (a === b) continue;
          assert.ok(Math.min(forward(a.t, b.t), forward(b.t, a.t)) >= MIN_GAP - 1e-9, `${a.id}/${b.id} a menos de MIN_GAP`);
        }
      }
    }
  });

  test('após a liberação, a composição retida retoma a marcha e entra na seção', () => {
    let s = ticks(initialState(NOW), 60, 10);
    s = ccoReducer(s, { type: 'RESTRICTION_CLEAR', restrictionId: 'TSR-08fe2b', confirmOperator: 'OP-4471', cctvVerified: true, at: AT });
    s = ticks(s, 5, 10);
    const vlt19 = s.trains.find((t) => t.id === 'VLT-19')!;
    assert.equal(vlt19.hold, null);
    assert.ok(isInside(vlt19.t, [0.02, 0.16]));
    assert.ok(s.log.some((e) => e.text === 'VLT-19 retomou marcha em direção a L2-S11'));
  });

  test('composição livre anda exatamente TRAIN_SPEED × dt', () => {
    const s0 = initialState(NOW);
    const s1 = ccoReducer(s0, { type: 'TICK', dtSec: 1, at: AT });
    assert.ok(Math.abs(forward(s0.trains[0].t, s1.trains[0].t) - TRAIN_SPEED) < 1e-12);
  });

  test('pausa (dt = 0) não altera o estado', () => {
    const s0 = initialState(NOW);
    assert.equal(ccoReducer(s0, { type: 'TICK', dtSec: 0, at: AT }), s0);
  });
});

test('reducer é puro: nunca muta o estado anterior', () => {
  const s0 = deepFreeze(initialState(NOW));
  assert.doesNotThrow(() =>
    run(s0, [
      { type: 'TICK', dtSec: 10, at: AT },
      { type: 'ALARM_ACK', alarmId: 'INC-a91f3c', at: AT },
      { type: 'RESTRICTION_CLEAR', restrictionId: 'TSR-08fe2b', confirmOperator: 'OP-4471', cctvVerified: true, at: AT },
      { type: 'RADIO_CALL', trainId: 'VLT-07', at: AT },
      { type: 'REGULATION_ADVICE', trainId: 'VLT-12', at: AT },
      { type: 'SELECT_TRAIN', trainId: 'VLT-12' },
      { type: 'LOGOUT', at: AT },
    ]),
  );
});
