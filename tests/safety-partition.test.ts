import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SafetyGuard } from '@railsentinel/ats-core/dist/safety-guard.js';
import { TspController } from '@railsentinel/ats-core/dist/tsp.js';
import { IntrusionHandler } from '@railsentinel/ats-core/dist/intrusion.js';
import { FleetRegistry } from '@railsentinel/ats-core/dist/fleet.js';
import { HeadwayRegulator, resolveSetpoint, trainsRequiredForTimetable, DWELL_MIN_S, DWELL_MAX_S } from '@railsentinel/ats-core/dist/headway.js';
import { uuidv7, type IntrusionData, type Message } from '@railsentinel/contracts';

/**
 * Estes testes sao a evidencia de particao EN 50716.
 *
 * Numa auditoria de certificacao, a pergunta nao e "o codigo comanda freio a
 * partir da IA?" - e "prove que nao pode". Cada caso abaixo tenta explicitamente
 * a escalacao e verifica que ela e recusada e registrada.
 */

const BOOT = Date.now();

function intrusionMsg(over: Partial<IntrusionData> = {}, envOver: Partial<Message['env']> = {}): Message<IntrusionData> {
  return {
    env: {
      v: 1, id: uuidv7(), seq: 1, boot: BOOT, ts: new Date().toISOString(),
      src: 'edge:jetson:XC-ANA-COSTA-01', site: 'santos', line: 'L2', zone: 'XC-ANA-COSTA',
      type: 'vlt.edge.intrusion.v1', class: 'basic', sev: 'critical', ...envOver,
    },
    data: {
      event: 'gauge_intrusion', state: 'onset',
      object: { class: 'car', conf: 0.94 },
      track: { section_id: 'L2-S11', chainage_m: 600, gauge_margin_m: -0.35 },
      detector: { model: 'railguard-yolo', model_version: '3.2.1', infer_ms: 11.4 },
      dwell_ms: 2400,
      ...over,
    },
  };
}

describe('SafetyGuard - particao EN 50716', () => {
  test('Integridade Basica PODE levantar alarme', () => {
    const g = new SafetyGuard();
    assert.equal(g.authorize('raise_alarm', 'basic', 'e1').permitted, true);
  });

  test('Integridade Basica PODE aconselhar restricao de velocidade', () => {
    const g = new SafetyGuard();
    assert.equal(g.authorize('advisory_speed_limit', 'basic', 'e1').permitted, true);
  });

  test('Integridade Basica PODE retirar prioridade semaforica (acao de remocao)', () => {
    const g = new SafetyGuard();
    assert.equal(g.authorize('revoke_tsp_request', 'basic', 'e1').permitted, true);
  });

  test('Integridade Basica NAO PODE comandar freio de emergencia', () => {
    const g = new SafetyGuard();
    const d = g.authorize('command_emergency_brake', 'basic', 'e1');
    assert.equal(d.permitted, false);
    assert.equal(d.violation?.required_class, 'sil4');
  });

  test('Integridade Basica NAO PODE estabelecer rota de intertravamento', () => {
    const g = new SafetyGuard();
    assert.equal(g.authorize('set_interlocking_route', 'basic', 'e1').permitted, false);
  });

  test('Integridade Basica NAO PODE liberar travamento de rota', () => {
    const g = new SafetyGuard();
    assert.equal(g.authorize('release_route_lock', 'basic', 'e1').permitted, false);
  });

  test('Integridade Basica NAO PODE sobrepor o ATP', () => {
    const g = new SafetyGuard();
    assert.equal(g.authorize('override_atp', 'basic', 'e1').permitted, false);
  });

  test('Integridade Basica NAO PODE conceder prioridade semaforica', () => {
    const g = new SafetyGuard();
    assert.equal(g.authorize('grant_tsp_request', 'basic', 'e1').permitted, false);
  });

  test('confianca alta do modelo NAO concede autoridade vital', () => {
    // O ponto central: 99,99% de confianca continua sendo Integridade Basica.
    const g = new SafetyGuard();
    assert.equal(g.authorize('command_emergency_brake', 'basic', 'modelo-99.99%').permitted, false);
  });

  test('SIL2 concede prioridade mas nao comanda freio', () => {
    const g = new SafetyGuard();
    assert.equal(g.authorize('grant_tsp_request', 'sil2', 'e1').permitted, true);
    assert.equal(g.authorize('command_emergency_brake', 'sil2', 'e1').permitted, false);
  });

  test('SIL4 tem autoridade plena', () => {
    const g = new SafetyGuard();
    for (const e of ['command_emergency_brake', 'set_interlocking_route', 'override_atp'] as const) {
      assert.equal(g.authorize(e, 'sil4', 'e1').permitted, true);
    }
  });

  test('toda tentativa barrada vira registro auditavel', () => {
    const g = new SafetyGuard();
    const seen: unknown[] = [];
    g.onViolation((v) => seen.push(v));
    g.authorize('command_emergency_brake', 'basic', 'evt-42');
    g.authorize('override_atp', 'basic', 'evt-43');
    assert.equal(g.violations.length, 2);
    assert.equal(seen.length, 2);
    assert.equal(g.violations[0]?.source_event_id, 'evt-42');
    assert.match(g.violations[0]?.rationale ?? '', /EN 50716/);
  });
});

describe('IntrusionHandler - fluxo de invasao de via', () => {
  function setup() {
    const guard = new SafetyGuard();
    const fleet = new FleetRegistry();
    const tsp = new TspController(guard);
    return { guard, fleet, tsp, handler: new IntrusionHandler(guard, fleet, tsp) };
  }

  test('invasao de alta confianca gera alarme e restricao', () => {
    const { handler } = setup();
    const out = handler.handle(intrusionMsg());
    assert.equal(out.accepted, true);
    assert.equal(out.kind, 'incident');
    assert.ok(out.alarm);
    assert.equal(out.alarm?.severity, 'critical');
    assert.ok(out.restriction);
    assert.equal(out.restriction?.kind, 'advisory_hold');
  });

  test('a restricao emitida NUNCA e vital - sempre advisory', () => {
    const { handler } = setup();
    const out = handler.handle(intrusionMsg());
    assert.ok(['advisory_speed_limit', 'advisory_hold'].includes(out.restriction!.kind));
    assert.equal(out.restriction?.origin_class, 'basic');
    assert.equal(out.restriction?.requires_operator_ack, true);
  });

  test('nenhuma violacao de particao ocorre no fluxo normal', () => {
    const { guard, handler } = setup();
    handler.handle(intrusionMsg());
    assert.equal(guard.violations.length, 0, 'o fluxo normal nao deve sequer tentar efeito vital');
  });

  test('confianca abaixo do limiar da classe e filtrada', () => {
    const { handler } = setup();
    const out = handler.handle(intrusionMsg({ object: { class: 'car', conf: 0.41 } }));
    assert.equal(out.accepted, false);
    assert.match(out.reason ?? '', /confianca/);
  });

  test('limiar de pessoa e mais baixo que o de detrito (assimetria de consequencia)', () => {
    const { handler } = setup();
    const pessoa = handler.handle(intrusionMsg({ object: { class: 'person', conf: 0.50 }, track: { section_id: 'L2-S11' } }));
    const detrito = handler.handle(intrusionMsg({ object: { class: 'debris', conf: 0.50 }, track: { section_id: 'L2-S12' } }));
    assert.equal(pessoa.accepted, true, 'pessoa a 50% deve passar');
    assert.equal(detrito.accepted, false, 'detrito a 50% deve ser filtrado');
  });

  test('deteccao transitoria de um quadro e filtrada', () => {
    const { handler } = setup();
    const out = handler.handle(intrusionMsg({
      object: { class: 'debris', conf: 0.9 },
      track: { section_id: 'L2-S11', gauge_margin_m: 0.5 },
      dwell_ms: 80,
    }));
    assert.equal(out.accepted, false);
    assert.match(out.reason ?? '', /persistencia/);
  });

  test('pessoa na via nao espera persistencia', () => {
    const { handler } = setup();
    const out = handler.handle(intrusionMsg({
      object: { class: 'person', conf: 0.8 },
      track: { section_id: 'L2-S11', gauge_margin_m: 0.5 },
      dwell_ms: 10,
    }));
    assert.equal(out.accepted, true, 'urgencia sobrepoe o filtro de persistencia');
  });

  test("'cleared' da borda NAO levanta a restricao sozinho", () => {
    const { handler, tsp } = setup();
    handler.handle(intrusionMsg());
    assert.equal(tsp.isInhibited('XC-ANA-COSTA'), true);

    const cleared = handler.handle(intrusionMsg({ state: 'cleared', dwell_ms: 0, track: { section_id: 'L2-S11', gauge_margin_m: 0.8 } }));
    assert.equal(cleared.accepted, true);
    assert.equal(cleared.kind, 'clear_candidate', 'um cleared nao e um incidente novo');
    assert.match(cleared.reason ?? '', /confirmacao do operador/);
    assert.equal(tsp.isInhibited('XC-ANA-COSTA'), true, 'a inibicao deve persistir apos o cleared');
    assert.ok(handler.openIncidents().includes('L2-S11'));
  });

  test('somente a confirmacao do operador reabre a secao', () => {
    const { handler, tsp } = setup();
    handler.handle(intrusionMsg());
    const r = handler.operatorClear('L2-S11');
    assert.equal(r.released, true);
    assert.equal(tsp.isInhibited('XC-ANA-COSTA'), false);
    assert.equal(handler.openIncidents().length, 0);
  });

  test('prioridade semaforica e suspensa a montante da obstrucao', () => {
    const { handler } = setup();
    const out = handler.handle(intrusionMsg());
    const crossings = out.tspRevocations.map((r) => r.crossing_id);
    assert.ok(crossings.includes('XC-ANA-COSTA'));
    assert.ok(crossings.length >= 1);
    assert.ok(out.tspRevocations.every((r) => r.action === 'revoke'));
  });

  test('eventos repetidos na mesma secao mantem um so incidente', () => {
    const { handler } = setup();
    const a = handler.handle(intrusionMsg());
    const b = handler.handle(intrusionMsg({ state: 'sustained', dwell_ms: 5000 }));
    assert.equal(a.incident_id, b.incident_id);
    assert.equal(a.restriction?.restriction_id, b.restriction?.restriction_id);
  });

  test('alarme carrega proveniencia do modelo para a IHM', () => {
    const { handler } = setup();
    const out = handler.handle(intrusionMsg());
    assert.equal(out.alarm?.provenance.integrity_class, 'basic');
    assert.equal(out.alarm?.provenance.confidence, 0.94);
    assert.match(out.alarm?.provenance.model ?? '', /railguard-yolo v3\.2\.1/);
  });

  test('secao fora da topologia e rejeitada', () => {
    const { handler } = setup();
    const out = handler.handle(intrusionMsg({ track: { section_id: 'SECAO-INEXISTENTE' } }));
    assert.equal(out.accepted, false);
    assert.match(out.reason ?? '', /desconhecida/);
  });
});

describe('TSP - portao adaptativo NTCIP 1202', () => {
  function train(over: Record<string, unknown> = {}) {
    return {
      train_id: 'VLT-07', section_id: 'L2-S11', chainage_m: 1150, speed_kmh: 25,
      schedule_dev_s: 95, linear_pos_m: 1150, updated_at: new Date().toISOString(), stale: false,
      ...over,
    } as any;
  }

  test('composicao atrasada recebe prioridade', () => {
    const tsp = new TspController(new SafetyGuard());
    const e = tsp.evaluate(train(), 'sil2', 'e1');
    assert.ok(e.decision, e.skipped_reason);
    assert.equal(e.decision?.action, 'request_grant');
  });

  test('composicao adiantada NAO recebe prioridade', () => {
    const tsp = new TspController(new SafetyGuard());
    const e = tsp.evaluate(train({ schedule_dev_s: -60 }), 'sil2', 'e1');
    assert.equal(e.decision, null);
    assert.match(e.skipped_reason ?? '', /adiantada/);
  });

  test('atraso abaixo do limiar NAO justifica prioridade', () => {
    const tsp = new TspController(new SafetyGuard());
    const e = tsp.evaluate(train({ schedule_dev_s: 20 }), 'sil2', 'e1');
    assert.equal(e.decision, null);
    assert.match(e.skipped_reason ?? '', /limiar/);
  });

  test('telemetria obsoleta NAO pede fase', () => {
    const tsp = new TspController(new SafetyGuard());
    const e = tsp.evaluate(train({ stale: true }), 'sil2', 'e1');
    assert.equal(e.decision, null);
    assert.match(e.skipped_reason ?? '', /obsoleta/);
  });

  test('evidencia de Integridade Basica NAO concede prioridade', () => {
    const guard = new SafetyGuard();
    const tsp = new TspController(guard);
    const e = tsp.evaluate(train(), 'basic', 'e1');
    assert.equal(e.decision, null);
    assert.match(e.skipped_reason ?? '', /SafetyGuard/);
    assert.equal(guard.violations.length, 1);
  });

  test('cruzamento inibido por incidente NAO recebe pedido', () => {
    const tsp = new TspController(new SafetyGuard());
    tsp.inhibit('XC-ANA-COSTA', 'obstrucao a jusante', 'basic', 'e1');
    const e = tsp.evaluate(train(), 'sil2', 'e1');
    assert.equal(e.decision, null);
    assert.match(e.skipped_reason ?? '', /suspensa/);
  });

  test('traducao para objetos MIB do NTCIP 1202', () => {
    const tsp = new TspController(new SafetyGuard());
    const e = tsp.evaluate(train(), 'sil2', 'e1');
    const cmd = tsp.toNtcip(e.decision!);
    assert.ok(cmd);
    assert.match(cmd!.endpoint, /^udp:\/\//);
    assert.equal(cmd!.mib_objects['priorityRequest.priorityRequestVehicleClass'], 6);
    assert.ok('priorityRequest.priorityRequestPhase' in cmd!.mib_objects);
  });

  test('extensao de verde tem teto para nao esfomear o transversal', () => {
    const tsp = new TspController(new SafetyGuard());
    const e = tsp.evaluate(train({ chainage_m: 1180, speed_kmh: 30 }), 'sil2', 'e1');
    if (e.decision?.ntcip_strategy === 'green_extension') {
      assert.ok((e.decision && tsp.toNtcip(e.decision)!.mib_objects['phaseTable.phaseMaxGreenExtension'] as number) <= 10);
    }
  });
});

describe('Regulacao de headway', () => {
  function t(id: string, pos: number, section = 'L2-S11') {
    return { train_id: id, section_id: section, chainage_m: 100, speed_kmh: 25, schedule_dev_s: 0, linear_pos_m: pos, updated_at: new Date().toISOString(), stale: false } as any;
  }

  test('setpoint e ciclo/N, nao o numero do quadro', () => {
    const sp = resolveSetpoint('L2', 3);
    assert.equal(sp.timetable_s, 1200);
    assert.equal(sp.setpoint_s, sp.feasible_s, 'a malha equaliza no unico espacamento sustentavel');
    assert.equal(sp.setpoint_s, Math.round(sp.cycle_time_s / 3));
  });

  test('frota suficiente supera o quadro e nao dispara aviso', () => {
    const sp = resolveSetpoint('L2', 3);
    assert.ok(sp.feasible_s < sp.timetable_s, '3 composicoes dao intervalo menor que o anunciado');
    assert.equal(sp.infeasible, false);
  });

  test('frota pequena demais para o quadro e sinalizada como planejamento', () => {
    // 1 composicao no loop: intervalo real = ciclo inteiro, maior que os 20 min.
    const sp = resolveSetpoint('L2', 1);
    assert.ok(sp.feasible_s > sp.timetable_s);
    assert.equal(sp.infeasible, true);
    assert.equal(trainsRequiredForTimetable('L2'), Math.ceil(sp.cycle_time_s / 1200));
  });

  test('dwell nunca cai abaixo do piso de acessibilidade', () => {
    const r = new HeadwayRegulator();
    // Intervalos enormes: o controlador quer acelerar tudo ao maximo.
    const cmds = r.regulate('L2', [t('A', 0), t('B', 4000), t('C', 8000)]);
    for (const c of cmds) assert.ok(c.dwell_s >= DWELL_MIN_S, `dwell ${c.dwell_s} abaixo do piso`);
  });

  test('dwell nunca excede o teto', () => {
    const r = new HeadwayRegulator();
    const cmds = r.regulate('L2', [t('A', 0), t('B', 10), t('C', 20)]);
    for (const c of cmds) assert.ok(c.dwell_s <= DWELL_MAX_S);
  });

  test('coasting fica na faixa de 4-8% quando aplicado', () => {
    const r = new HeadwayRegulator();
    const cmds = r.regulate('L2', [t('A', 0), t('B', 5), t('C', 10)]);
    for (const c of cmds) {
      if (c.coast_pct > 0) {
        assert.ok(c.coast_pct >= 4 && c.coast_pct <= 8, `coasting ${c.coast_pct}% fora da faixa`);
      }
    }
  });

  test('menos de duas composicoes nao produz comando', () => {
    const r = new HeadwayRegulator();
    assert.equal(r.regulate('L2', [t('A', 0)]).length, 0);
  });

  test('composicoes com telemetria obsoleta sao ignoradas como referencia', () => {
    const r = new HeadwayRegulator();
    const stale = { ...t('B', 1000), stale: true };
    assert.equal(r.regulate('L2', [t('A', 0), stale]).length, 0);
  });

  test('trem colado no da frente recebe dwell maior que o do intervalo folgado', () => {
    const r = new HeadwayRegulator();
    const cmds = r.regulate('L2', [t('A', 0), t('B', 100), t('C', 6000)]);
    const a = cmds.find((c) => c.train_id === 'A')!;
    const c = cmds.find((c) => c.train_id === 'C')!;
    assert.ok(a.dwell_s > c.dwell_s, 'o trem em bunching deve ser segurado mais que o folgado');
  });
});
