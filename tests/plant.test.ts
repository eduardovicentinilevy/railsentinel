import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { TramPlant, L2_PLANT_CONFIG, makeTrain, Rng } from '@railsentinel/plant';
import { traversalTimeS, lineLengthM } from '@railsentinel/ats-core/dist/topology.js';
import { resolveSetpoint, HeadwayRegulator, DWELL_NOMINAL_S } from '@railsentinel/ats-core/dist/headway.js';

describe('Planta da frota', () => {
  test('o piso de acessibilidade e restricao LOCAL - o CCO nao pode baixar dele', () => {
    const p = new TramPlant(L2_PLANT_CONFIG, [makeTrain('A', 0, 0)]);
    p.applyCommands([{ train_id: 'A', dwell_s: 5, coast_pct: 0 }]);
    assert.equal(p.trains[0]!.commandedDwell_s, L2_PLANT_CONFIG.dwellFloor_s);
  });

  test('o teto de coasting e aplicado localmente', () => {
    const p = new TramPlant(L2_PLANT_CONFIG, [makeTrain('A', 0, 0)]);
    p.applyCommands([{ train_id: 'A', dwell_s: 30, coast_pct: 50 }]);
    assert.equal(p.trains[0]!.commandedCoast_pct, L2_PLANT_CONFIG.coastMax_pct);
  });

  test('dwell acima do nominal aumenta o desvio de tabela', () => {
    const p = new TramPlant(L2_PLANT_CONFIG, [makeTrain('A', 0, 1190)]);
    p.applyCommands([{ train_id: 'A', dwell_s: 60, coast_pct: 0 }]);
    for (let i = 0; i < 10; i++) p.step(1);
    assert.ok(p.trains[0]!.schedule_dev_s > 0, 'dwell maior deve atrasar a composicao');
    assert.equal(p.trains[0]!.schedule_dev_s, 60 - DWELL_NOMINAL_S);
  });

  test('coasting reduz a velocidade efetiva', () => {
    const p = new TramPlant(L2_PLANT_CONFIG, [makeTrain('A', 0, 100)]);
    p.applyCommands([{ train_id: 'A', dwell_s: 30, coast_pct: 8 }]);
    p.step(1);
    const expected = L2_PLANT_CONFIG.sections[0]!.line_speed_kmh * 0.92;
    assert.ok(Math.abs(p.trains[0]!.speed_kmh - expected) < 0.01);
  });

  test('o trem percorre o loop e volta a secao inicial', () => {
    const p = new TramPlant(L2_PLANT_CONFIG, [makeTrain('A', 0, 0)]);
    for (let i = 0; i < 4000; i++) p.step(1);
    assert.ok(p.trains[0]!.stopsServed >= 7, 'ao menos uma volta completa');
  });

  test('o gerador e reprodutivel a partir da semente', () => {
    const a = new Rng(42); const b = new Rng(42);
    assert.deepEqual([a.next(), a.next(), a.next()], [b.next(), b.next(), b.next()]);
  });
});

describe('Headway: medicao e setpoint na mesma base', () => {
  test('o headway medido inclui os dwells do trecho', () => {
    // Sem dwell: apenas o tempo de percurso. Com dwell: mais alto.
    const gap = lineLengthM('L2') / 3;
    const semDwell = traversalTimeS('L2', 0, gap, 0);
    const comDwell = traversalTimeS('L2', 0, gap, 30);
    assert.ok(comDwell > semDwell, 'dwell precisa entrar na conta');
    assert.ok(comDwell - semDwell >= 30, 'ao menos uma parada no trecho');
  });

  test('o vies sistematico contra o setpoint desapareceu', () => {
    // Antes da correcao, o erro medio era ~-71s em qualquer posicao, porque a
    // medicao ignorava 210s de dwell que o setpoint incluia.
    const sp = resolveSetpoint('L2', 3).setpoint_s;
    const gap = lineLengthM('L2') / 3;
    const errs = [0, 1200, 2700, 4100, 5200, 6100, 7100]
      .map((from) => traversalTimeS('L2', from, gap, DWELL_NOMINAL_S) - sp);
    const mean = errs.reduce((a, b) => a + b, 0) / errs.length;
    assert.ok(Math.abs(mean) < 25, `vies medio ${mean.toFixed(1)}s ainda alto`);
  });

  test('percorrer o loop inteiro reproduz o tempo de ciclo', () => {
    const total = traversalTimeS('L2', 0, lineLengthM('L2'), DWELL_NOMINAL_S);
    const cycle = resolveSetpoint('L2', 1).cycle_time_s;
    assert.ok(Math.abs(total - cycle) < 40, `percurso ${total.toFixed(0)}s vs ciclo ${cycle}s`);
  });
});

describe('Estabilidade em malha fechada (regressao)', () => {
  /**
   * Guarda os dois resultados do banco de estabilidade. Se alguem alterar
   * ganhos ou planta, a regressao aparece aqui antes de chegar a bancada.
   *
   * Sao DUAS propriedades distintas, e o banco so e honesto se cobrir as duas:
   *
   *  A) sob ruido de embarque continuo - a condicao real - o regulador reduz
   *     substancialmente o erro de headway;
   *  B) sob impulso isolado, sem variabilidade posterior, ele nao DEGRADA. Nao
   *     ha ganho a esperar aqui: sem perturbacao recorrente nao ha o que
   *     rejeitar, e atuar custa tanto quanto rende.
   *
   * Afirmar ganho no regime B seria escolher a evidencia conveniente.
   */
  function rmsError(controller: boolean, ongoingNoise: boolean): number {
    const rng = new Rng(1);
    const plant = new TramPlant(L2_PLANT_CONFIG, [
      makeTrain('A', 0, 0), makeTrain('B', 2, 400), makeTrain('C', 4, 200),
    ]);
    const reg = new HeadwayRegulator();
    const sp = resolveSetpoint('L2', 3).setpoint_s;
    let sumSq = 0, n = 0;

    for (let t = 0; t < 7200; t++) {
      if (t === 1200) plant.injectSurge('A', 90);
      if (t % 10 === 0) {
        const states = plant.trains.map((tr) => ({
          train_id: tr.id, section_id: L2_PLANT_CONFIG.sections[tr.sectionIdx]!.id,
          chainage_m: tr.chainage_m, speed_kmh: tr.speed_kmh,
          schedule_dev_s: Math.round(tr.schedule_dev_s),
          linear_pos_m: plant.linearPosition(tr), updated_at: new Date().toISOString(), stale: false,
        })).sort((a, b) => a.linear_pos_m - b.linear_pos_m);

        if (controller) {
          plant.applyCommands(reg.regulate('L2', states as never)
            .map((c) => ({ train_id: c.train_id, dwell_s: c.dwell_s, coast_pct: c.coast_pct })));
        }
        if (t > 1200) {
          const errs: number[] = [];
          for (let i = 0; i < states.length; i++) {
            const a = states[i]!, b = states[(i + 1) % states.length]!;
            let gap = b.linear_pos_m - a.linear_pos_m;
            if (gap <= 0) gap += plant.loopLength_m;
            errs.push(traversalTimeS('L2', a.linear_pos_m, gap, DWELL_NOMINAL_S) - sp);
          }
          const rms = Math.sqrt(errs.reduce((q, e) => q + e * e, 0) / errs.length);
          sumSq += rms * rms; n += 1;
        }
      }
      plant.step(1);
      if (ongoingNoise && t % 120 === 0) {
        plant.injectSurge(rng.pick(plant.trains.map((x) => x.id)), rng.range(0, 8));
      }
    }
    return Math.sqrt(sumSq / n);
  }

  test('A) sob ruido continuo o regulador reduz o erro de headway em pelo menos 20%', () => {
    const open = rmsError(false, true);
    const closed = rmsError(true, true);
    const improvement = 1 - closed / open;
    assert.ok(improvement > 0.2,
      `melhora de apenas ${(improvement * 100).toFixed(0)}% (aberta ${open.toFixed(0)}s, fechada ${closed.toFixed(0)}s)`);
  });

  test('B) sob impulso isolado o regulador nao degrada o sistema', () => {
    const open = rmsError(false, false);
    const closed = rmsError(true, false);
    const ratio = closed / open;
    assert.ok(ratio < 1.15,
      `razao fechada/aberta = ${ratio.toFixed(2)}x (aberta ${open.toFixed(0)}s, fechada ${closed.toFixed(0)}s)`);
  });

  test('o regulador nunca viola o piso de acessibilidade', () => {
    const reg = new HeadwayRegulator();
    const mk = (id: string, pos: number) => ({
      train_id: id, section_id: 'L2-S11', chainage_m: 100, speed_kmh: 25, schedule_dev_s: 0,
      linear_pos_m: pos, updated_at: new Date().toISOString(), stale: false,
    });
    for (const spread of [[0, 10, 20], [0, 4000, 8000], [0, 100, 200]]) {
      const cmds = reg.regulate('L2', spread.map((p, i) => mk(`T${i}`, p)) as never);
      for (const c of cmds) assert.ok(c.dwell_s >= L2_PLANT_CONFIG.dwellFloor_s);
    }
  });
});
