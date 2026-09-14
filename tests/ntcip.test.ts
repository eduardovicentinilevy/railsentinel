import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SignalController, type PhaseConfig } from '@railsentinel/ntcip-emulator/dist/controller.js';
import { TspController } from '@railsentinel/ats-core/dist/tsp.js';
import { SafetyGuard } from '@railsentinel/ats-core/dist/safety-guard.js';

/**
 * Testes do HIL NTCIP 1202.
 *
 * O valor do emulador esta nas RECUSAS: um controlador que concedesse toda
 * prioridade pedida faria o TSP parecer perfeito na bancada e falhar em campo.
 * Estes testes travam as restricoes que tornam o problema real.
 */

function phases(vlt = 2): PhaseConfig[] {
  return [
    { phase: vlt, minGreen: 8, maxGreen: 45, yellow: 3, allRed: 2, splitGreen: 22, label: 'VLT' },
    { phase: 4, minGreen: 12, maxGreen: 50, yellow: 3, allRed: 2, splitGreen: 28, label: 'transversal' },
    { phase: 8, minGreen: 7, maxGreen: 25, yellow: 3, allRed: 2, splitGreen: 12, label: 'pedestre' },
  ];
}

const req = (o: Partial<Parameters<SignalController['applyPriorityRequest']>[0]> = {}) => ({
  phase: 2, strategy: 1, vehicleClass: 6, requestId: 'r1', maxExtension: 10, ...o,
});

describe('Controlador semaforico - restricoes de seguranca', () => {
  test('verde minimo e respeitado mesmo sob force-off', () => {
    const c = new SignalController('X', phases());
    // Avanca para a fase transversal
    while (c.state.activePhase === 2) c.tick(1);
    while (c.state.color !== 'green') c.tick(1);
    const active = c.state.activePhase;
    const min = c.phaseConfig(active)!.minGreen;

    c.applyPriorityRequest(req({ strategy: 3 })); // red_truncation
    let elapsedGreen = 0;
    while (c.state.color === 'green' && c.state.activePhase === active) { c.tick(1); elapsedGreen += 1; }
    assert.ok(elapsedGreen >= min, `verde durou ${elapsedGreen}s, minimo ${min}s`);
  });

  test('amarelo e vermelho-geral nunca sao encurtados', () => {
    const c = new SignalController('X', phases());
    while (c.state.color !== 'yellow') c.tick(1);
    const cfg = c.phaseConfig(c.state.activePhase)!;
    let y = 0;
    while (c.state.color === 'yellow') { c.tick(1); y += 1; }
    assert.ok(y >= cfg.yellow, `amarelo ${y}s < ${cfg.yellow}s`);
    let r = 0;
    while (c.state.color === 'all_red') { c.tick(1); r += 1; }
    assert.ok(r >= cfg.allRed, `vermelho-geral ${r}s < ${cfg.allRed}s`);
  });

  test('extensao de verde nao ultrapassa o verde maximo', () => {
    const c = new SignalController('X', phases());
    while (!(c.state.activePhase === 2 && c.state.color === 'green')) c.tick(1);
    const cfg = c.phaseConfig(2)!;
    let total = 0;
    for (let i = 0; i < 20; i++) {
      const r = c.applyPriorityRequest(req({ strategy: 2, maxExtension: 10 }));
      if (r.granted) total += 10;
      else break;
    }
    assert.ok(cfg.splitGreen + c.state.grantedExtension <= cfg.maxGreen,
      `verde ${cfg.splitGreen + c.state.grantedExtension}s excede maximo ${cfg.maxGreen}s`);
  });

  test('extensao pedida fora de verde e recusada', () => {
    const c = new SignalController('X', phases());
    while (!(c.state.activePhase !== 2 || c.state.color !== 'green')) c.tick(1);
    const r = c.applyPriorityRequest(req({ strategy: 2 }));
    assert.equal(r.granted, false);
  });

  test('truncamento com a fase do VLT ja ativa e recusado', () => {
    const c = new SignalController('X', phases());
    while (!(c.state.activePhase === 2 && c.state.color === 'green')) c.tick(1);
    const r = c.applyPriorityRequest(req({ strategy: 3 }));
    assert.equal(r.granted, false);
    assert.match(r.granted ? '' : r.reason, /ja ativa/);
  });

  test('chamada de fase antecipa a fase do VLT no proximo intervalo', () => {
    const c = new SignalController('X', phases());
    while (c.state.activePhase === 2) c.tick(1);
    const r = c.applyPriorityRequest(req({ strategy: 1 }));
    assert.equal(r.granted, true);
    let guard = 0;
    while (c.state.activePhase !== 2 && guard++ < 500) c.tick(1);
    assert.equal(c.state.activePhase, 2, 'a fase chamada deve ser servida');
  });

  test('fase inexistente e recusada', () => {
    const c = new SignalController('X', phases());
    assert.equal(c.applyPriorityRequest(req({ phase: 99 })).granted, false);
  });

  test('secondsUntilGreen e zero quando a fase ja esta verde', () => {
    const c = new SignalController('X', phases());
    while (!(c.state.activePhase === 2 && c.state.color === 'green')) c.tick(1);
    assert.equal(c.secondsUntilGreen(2), 0);
  });

  test('secondsUntilGreen decresce ao longo do ciclo', () => {
    const c = new SignalController('X', phases());
    while (c.state.activePhase === 2) c.tick(1);
    const a = c.secondsUntilGreen(2);
    c.tick(3);
    const b = c.secondsUntilGreen(2);
    assert.ok(b < a, `${b} deveria ser menor que ${a}`);
  });

  test('o ciclo avanca e volta ao inicio', () => {
    const c = new SignalController('X', phases());
    for (let i = 0; i < 400; i++) c.tick(1);
    assert.ok(c.state.cycleCount >= 1, 'ao menos um ciclo completo em 400s');
  });
});

describe('TSP em malha fechada', () => {
  const train = (o: Record<string, unknown> = {}) => ({
    train_id: 'VLT-07', section_id: 'L2-S11', chainage_m: 1150, speed_kmh: 25,
    schedule_dev_s: 95, linear_pos_m: 1150, updated_at: new Date().toISOString(), stale: false, ...o,
  }) as never;

  test('pedido em voo suprime reemissao - defesa contra oscilacao', () => {
    const t = new TspController(new SafetyGuard());
    const first = t.evaluate(train(), 'sil2', 'e1');
    assert.ok(first.decision, 'primeiro pedido deve sair');
    const second = t.evaluate(train({ chainage_m: 1180 }), 'sil2', 'e2');
    assert.equal(second.decision, null);
    assert.match(second.skipped_reason ?? '', /em voo/);
  });

  test('realimentacao de verde iminente dispensa o pedido', () => {
    const t = new TspController(new SafetyGuard());
    t.observe({
      crossing_id: 'XC-ANA-COSTA', active_phase: 4, color: 'all_red',
      seconds_until_vlt_green: 2, granted_extension_s: 0, cross_street_debt_s: 0, at: Date.now(),
    });
    const e = t.evaluate(train(), 'sil2', 'e1');
    assert.equal(e.decision, null);
    assert.match(e.skipped_reason ?? '', /desnecessaria/);
  });

  test('estrategia segue o estado real do controlador', () => {
    const t = new TspController(new SafetyGuard());
    t.observe({
      crossing_id: 'XC-ANA-COSTA', active_phase: 2, color: 'green',
      seconds_until_vlt_green: 999, granted_extension_s: 0, cross_street_debt_s: 0, at: Date.now(),
    });
    const e = t.evaluate(train(), 'sil2', 'e1');
    assert.equal(e.decision?.ntcip_strategy, 'green_extension',
      'fase do VLT ja verde deve pedir extensao, nao chamada');
  });

  test('taxa de atendimento e contabilizada a partir dos desfechos reais', () => {
    const t = new TspController(new SafetyGuard());
    t.recordOutcome({ crossing_id: 'A', request_id: '1', granted: true });
    t.recordOutcome({ crossing_id: 'A', request_id: '2', granted: false, reason: 'verde maximo' });
    assert.equal(t.grantRate(), 0.5);
  });

  test('desfecho registrado libera o cruzamento para novo pedido', () => {
    const t = new TspController(new SafetyGuard());
    const first = t.evaluate(train(), 'sil2', 'e1');
    t.recordOutcome({ crossing_id: 'XC-ANA-COSTA', request_id: first.request_id!, granted: true });
    const second = t.evaluate(train({ chainage_m: 1180 }), 'sil2', 'e2');
    assert.ok(second.decision, 'apos o desfecho, novo pedido e permitido');
  });
});
