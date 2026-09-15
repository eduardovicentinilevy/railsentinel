/**
 * Banco de estabilidade - marco da Fase 1.
 *
 * Duas evidencias independentes, porque nenhuma sozinha basta:
 *
 * 1. ANALITICA. Lineariza a malha de headway na regiao nao saturada e calcula
 *    os autovalores de malha fechada. Estabilidade assintotica em tempo
 *    discreto exige raio espectral < 1. Da tambem amortecimento e constante de
 *    tempo, que dizem NAO SO se converge, mas como.
 *
 * 2. EMPIRICA. Roda a planta real em malha fechada com relogio virtual,
 *    injeta perturbacao em degrau e mede rejeicao. Cobre o que a linearizacao
 *    nao cobre: saturacao de dwell, piso de acessibilidade, anti-windup,
 *    acoplamento entre composicoes e o wrap do loop.
 *
 * A linearizacao sozinha seria otimista (ignora saturacao); a simulacao sozinha
 * seria anedota (uma semente, um cenario). Juntas sustentam a afirmacao de
 * "patamar matematicamente estavel" exigida pelo roadmap.
 */
import { writeFileSync } from 'node:fs';
import { HeadwayRegulator, resolveSetpoint, DWELL_NOMINAL_S } from '@railsentinel/ats-core/dist/headway.js';
import { traversalTimeS } from '@railsentinel/ats-core/dist/topology.js';
import { TramPlant, L2_PLANT_CONFIG, makeTrain, Rng, type PlantCommand } from '@railsentinel/plant';
import { abs, c, eigen2x2, rootsOfUnity, scale, sub, mul, type C } from './lib/complex.ts';

const KP = 0.25;
const KI = 0.02;
/** Periodo de amostragem da malha de regulacao, em segundos. */
const T_SAMPLE = 10;
const N_TRAINS = 3;

/* ================================================================== */
/* 1. ANALISE ANALITICA                                                */
/* ================================================================== */

/**
 * Modelo linearizado da malha de headway - COM o acoplamento entre composicoes.
 *
 * A primeira versao deste banco modelava cada par de trens isoladamente
 * (e+ = e - u) e concluia rho = 0,866, "estavel". A simulacao empirica entao
 * mostrou o controlador PIORANDO o sistema. A discrepancia expos o erro do
 * modelo: num circuito fechado os headways nao sao independentes.
 *
 * Segurar o trem i por Δ segundos aumenta o intervalo de i para o da frente,
 * mas reduz na mesma medida o intervalo do trem de tras para i:
 *
 *     e_i+  = e_i + Δ_i - Δ_{i+1}          ou seja   e+ = e + (I - S)·Δ
 *
 * com S o operador de deslocamento circular. A soma dos headways e o tempo de
 * ciclo, constante - por isso (I - S) tem um autovalor nulo, na direcao
 * uniforme, que o controlador nao pode nem precisa corrigir.
 *
 * Diagonalizando por Fourier, cada modo k tem ganho λ_k = 1 - ω^k, com
 * ω = e^{2πi/N}. Para N = 3, |λ_k| = √3 ≈ 1,73 nos modos nao uniformes: o
 * ganho efetivo da malha e QUASE O DOBRO do que o modelo isolado supunha. E
 * exatamente essa amplificacao que a simulacao estava sentindo.
 *
 * Por modo, o sistema de 2a ordem fica:
 *     e+ = (1 - λ_k·Kp)·e - λ_k·I
 *     I+ = Ki·T·(1 - λ_k·Kp)·e + (1 - Ki·T·λ_k)·I
 */
function modalSpectralRadius(kp: number, ki: number, T: number, n: number): { rho: number; perMode: Array<{ k: number; lambda: C; rho: number }> } {
  const w = rootsOfUnity(n);
  const perMode: Array<{ k: number; lambda: C; rho: number }> = [];
  let rho = 0;

  for (let k = 1; k < n; k++) {
    // Modo k=0 (uniforme) e omitido: corresponde a deslocar todos os trens
    // igualmente, que nao altera headway algum. Nao e controlavel nem precisa.
    const lambda = sub(c(1, 0), w[k]!);
    const kiT = ki * T;

    const A11 = sub(c(1, 0), scale(mul(lambda, c(kp, 0)), 1));
    const A12 = scale(lambda, -1);
    const A21 = scale(A11, kiT);
    const A22 = sub(c(1, 0), scale(lambda, kiT));

    const [e1, e2] = eigen2x2(A11, A12, A21, A22);
    const r = Math.max(abs(e1), abs(e2));
    perMode.push({ k, lambda, rho: r });
    rho = Math.max(rho, r);
  }
  return { rho, perMode };
}

function analytical(kp = KP, ki = KI, T = T_SAMPLE, n = N_TRAINS) {
  const { rho, perMode } = modalSpectralRadius(kp, ki, T, n);
  const settling = rho > 0 && rho < 1 ? (Math.log(0.02) / Math.log(rho)) * T : Infinity;

  // Margem de ganho: fator pelo qual Kp pode crescer antes de rho atingir 1.
  let gainMargin = 0;
  for (let m = 1.0; m <= 20; m += 0.02) {
    if (modalSpectralRadius(kp * m, ki, T, n).rho >= 1) break;
    gainMargin = m;
  }

  return {
    kp, ki, T_sample_s: T, trains: n,
    coupling: 'circulante (I - S); modo uniforme nao controlavel',
    modes: perMode.map((m) => ({
      k: m.k,
      lambda: `${m.lambda.re.toFixed(3)}${m.lambda.im >= 0 ? '+' : ''}${m.lambda.im.toFixed(3)}i`,
      lambda_mag: Number(abs(m.lambda).toFixed(4)),
      rho: Number(m.rho.toFixed(4)),
    })),
    spectral_radius: Number(rho.toFixed(4)),
    stable: rho < 1,
    settling_time_s: Number(settling.toFixed(1)),
    gain_margin: Number(gainMargin.toFixed(2)),
  };
}

/**
 * Varredura de ganhos: escolhe (Kp, Ki) minimizando o raio espectral modal.
 *
 * Os ganhos originais nao foram sintonizados - foram chutados sobre um modelo
 * que ignorava o acoplamento. A varredura substitui o chute por uma escolha
 * defensavel, e a margem resultante e o que se leva para a auditoria.
 */
function tuneGains(T: number, n: number): { kp: number; ki: number; rho: number } {
  let best = { kp: KP, ki: KI, rho: Infinity };
  for (let kp = 0.02; kp <= 0.80; kp += 0.01) {
    for (let ki = 0.0005; ki <= 0.03; ki += 0.0005) {
      const { rho } = modalSpectralRadius(kp, ki, T, n);
      // Preferimos margem folgada a convergencia agressiva: um regulador
      // rapido demais produz variacao de dwell perceptivel ao passageiro.
      if (rho < best.rho) best = { kp: Number(kp.toFixed(3)), ki: Number(ki.toFixed(4)), rho };
    }
  }
  return { ...best, rho: Number(best.rho.toFixed(4)) };
}

/* ================================================================== */
/* 2. SIMULACAO EMPIRICA EM MALHA FECHADA                              */
/* ================================================================== */

interface RunResult {
  seed: number;
  spread_initial_s: number;
  spread_peak_s: number;
  spread_final_s: number;
  settling_time_s: number | null;
  rms_error_s: number;
  diverged: boolean;
  dwell_floor_violations: number;
  coast_violations: number;
  samples: Array<{ t: number; spread: number; rms: number }>;
}

function runClosedLoop(opts: { seed: number; durationS: number; controller: boolean; disturbAtS: number; disturbMagS: number; kp?: number; ki?: number; ongoingNoise?: boolean }): RunResult {
  const { seed, durationS, controller, disturbAtS, disturbMagS } = opts;
  const rng = new Rng(seed);
  const regulator = new HeadwayRegulator(opts.kp ?? KP, opts.ki ?? KI);

  // Trens distribuidos de forma aproximadamente uniforme, com desvio inicial.
  const plant = new TramPlant(L2_PLANT_CONFIG, [
    makeTrain('VLT-07', 0, 0),
    makeTrain('VLT-12', 2, 400),
    makeTrain('VLT-19', 4, 200),
  ]);

  const dt = 1;
  const setpoint = resolveSetpoint('L2', 3).setpoint_s;
  const samples: RunResult['samples'] = [];
  let peak = 0;
  let floorViolations = 0;
  let coastViolations = 0;
  let sumSq = 0;
  let n = 0;
  let disturbed = false;
  let settling: number | null = null;
  const BAND_S = 30; // criterio de acomodacao: erro RMS abaixo de 30s

  for (let t = 0; t < durationS; t += dt) {
    if (!disturbed && t >= disturbAtS) {
      disturbed = true;
      plant.injectSurge(plant.trains[0]!.id, disturbMagS);
    }

    if (t % T_SAMPLE === 0) {
      const states = plant.trains.map((tr) => ({
        train_id: tr.id,
        section_id: L2_PLANT_CONFIG.sections[tr.sectionIdx]!.id,
        chainage_m: tr.chainage_m,
        speed_kmh: tr.speed_kmh,
        schedule_dev_s: Math.round(tr.schedule_dev_s),
        linear_pos_m: plant.linearPosition(tr),
        updated_at: new Date().toISOString(),
        stale: false,
      }));
      states.sort((a, b) => a.linear_pos_m - b.linear_pos_m);

      if (controller) {
        const cmds = regulator.regulate('L2', states as never);
        for (const c of cmds) {
          if (c.dwell_s < L2_PLANT_CONFIG.dwellFloor_s) floorViolations += 1;
          if (c.coast_pct > L2_PLANT_CONFIG.coastMax_pct) coastViolations += 1;
        }
        plant.applyCommands(cmds.map((c): PlantCommand => ({ train_id: c.train_id, dwell_s: c.dwell_s, coast_pct: c.coast_pct })));
      }

      // Erro de headway observado, na mesma base do controlador.
      const errs: number[] = [];
      for (let i = 0; i < states.length; i++) {
        const a = states[i]!;
        const b = states[(i + 1) % states.length]!;
        let gap = b.linear_pos_m - a.linear_pos_m;
        if (gap <= 0) gap += plant.loopLength_m;
        errs.push(traversalTimeS('L2', a.linear_pos_m, gap, DWELL_NOMINAL_S) - setpoint);
      }
      const rms = Math.sqrt(errs.reduce((s, e) => s + e * e, 0) / errs.length);
      const spread = plant.scheduleSpread_s();
      peak = Math.max(peak, spread);
      samples.push({ t, spread: Math.round(spread), rms: Math.round(rms) });

      if (t > disturbAtS) {
        sumSq += rms * rms;
        n += 1;
        if (settling === null && rms <= BAND_S) {
          // Exige permanencia: 5 amostras consecutivas dentro da faixa.
          const recent = samples.slice(-5);
          if (recent.length === 5 && recent.every((s) => s.rms <= BAND_S)) settling = t - disturbAtS;
        }
      }
    }

    plant.step(dt);
    // Ruido de embarque de baixa amplitude. E a condicao real de operacao - a
    // demanda de plataforma varia a cada partida - e e justamente o regime em
    // que um regulador tem o que fazer. Desligavel para separar rejeicao de
    // perturbacao continua de resposta a impulso isolado.
    if (opts.ongoingNoise !== false && t % 120 === 0) {
      plant.injectSurge(rng.pick(plant.trains.map((x) => x.id)), rng.range(0, 8));
    }
  }

  const finalSpread = plant.scheduleSpread_s();
  const first = samples[0]?.spread ?? 0;
  return {
    seed,
    spread_initial_s: Math.round(first),
    spread_peak_s: Math.round(peak),
    spread_final_s: Math.round(finalSpread),
    settling_time_s: settling,
    rms_error_s: n > 0 ? Number(Math.sqrt(sumSq / n).toFixed(1)) : 0,
    // Divergencia: a dispersao final excede em muito o pico da perturbacao.
    diverged: finalSpread > Math.max(600, peak * 1.5),
    dwell_floor_violations: floorViolations,
    coast_violations: coastViolations,
    samples,
  };
}

/* ================================================================== */

function main(): void {
  const DURATION = 7200; // 2 horas de operacao
  const DISTURB_AT = 1200;
  const DISTURB_MAG = 90;
  const seeds = [1, 7, 13, 29, 41, 97, 131, 257];

  console.log('═══ BANCO DE ESTABILIDADE — Fase 1 ═══\n');

  console.log('1) ANALISE MODAL (malha circulante linearizada)');
  const original = analytical(KP, KI);
  console.log(`   ganho de acoplamento por modo: ${original.modes.map((m) => `λ${m.k}=${m.lambda} (|λ|=${m.lambda_mag})`).join(', ')}`);
  console.log(`   modo uniforme (k=0) omitido: deslocar todos os trens igualmente nao altera headway\n`);
  console.log(`   ganhos originais  Kp=${KP} Ki=${KI}  →  ρ = ${original.spectral_radius}  ${original.stable ? 'estavel' : '❌ INSTAVEL'}`);

  const tuned = tuneGains(T_SAMPLE, N_TRAINS);
  const an = analytical(tuned.kp, tuned.ki);
  console.log(`   ganhos sintonizados Kp=${tuned.kp} Ki=${tuned.ki}  →  ρ = ${an.spectral_radius}  ${an.stable ? '✅ estavel' : 'INSTAVEL'}`);
  console.log(`   acomodacao 2% ≈ ${an.settling_time_s}s | margem de ganho = ${an.gain_margin}×\n`);

  console.log('2) SIMULACAO EMPIRICA (planta real, relogio virtual, 2h, 8 sementes)');
  console.log(`   perturbacao: surto de embarque de ${DISTURB_MAG}s em t=${DISTURB_AT}s\n`);

  const mk = (controller: boolean, ongoingNoise: boolean, kp?: number, ki?: number) =>
    seeds.map((seed) => runClosedLoop({ seed, durationS: DURATION, controller, disturbAtS: DISTURB_AT, disturbMagS: DISTURB_MAG, ongoingNoise, ...(kp ? { kp, ki } : {}) }));

  const open = mk(false, true);
  const origRun = mk(true, true, KP, KI);
  const closed = mk(true, true, tuned.kp, tuned.ki);
  // Regime de impulso isolado: sem variabilidade de embarque apos a perturbacao.
  const openImpulse = mk(false, false);
  const closedImpulse = mk(true, false, tuned.kp, tuned.ki);

  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const settled = closed.filter((r) => r.settling_time_s !== null);

  const col = (s: string | number, w = 14) => String(s).padStart(w);
  console.log('   REGIME A — ruido de embarque continuo (condicao real de operacao)');
  console.log(`                        ${col('SEM CONTROLE')} ${col('Kp=' + KP)} ${col('Kp=' + tuned.kp)}`);
  console.log(`   erro RMS de headway  ${col(avg(open.map((r) => r.rms_error_s)).toFixed(0) + 's')} ${col(avg(origRun.map((r) => r.rms_error_s)).toFixed(0) + 's')} ${col(avg(closed.map((r) => r.rms_error_s)).toFixed(0) + 's')}`);
  console.log(`   dispersao final      ${col(avg(open.map((r) => r.spread_final_s)).toFixed(0) + 's')} ${col(avg(origRun.map((r) => r.spread_final_s)).toFixed(0) + 's')} ${col(avg(closed.map((r) => r.spread_final_s)).toFixed(0) + 's')}`);
  console.log(`   divergiu             ${col(open.filter((r) => r.diverged).length + '/' + seeds.length)} ${col(origRun.filter((r) => r.diverged).length + '/' + seeds.length)} ${col(closed.filter((r) => r.diverged).length + '/' + seeds.length)}`);
  console.log(`   acomodou (RMS<30s)   ${col(open.filter((r) => r.settling_time_s !== null).length + '/' + seeds.length)} ${col(origRun.filter((r) => r.settling_time_s !== null).length + '/' + seeds.length)} ${col(settled.length + '/' + seeds.length)}`);
  if (settled.length) console.log(`   tempo de acomodacao  ${col('—')} ${col('—')} ${col(avg(settled.map((r) => r.settling_time_s!)).toFixed(0) + 's')}`);
  console.log();

  console.log('   REGIME B — impulso isolado, sem variabilidade posterior');
  console.log(`                        ${col('SEM CONTROLE')} ${col('Kp=' + tuned.kp)}`);
  console.log(`   erro RMS de headway  ${col(avg(openImpulse.map((r) => r.rms_error_s)).toFixed(0) + 's')} ${col(avg(closedImpulse.map((r) => r.rms_error_s)).toFixed(0) + 's')}`);
  console.log(`   divergiu             ${col(openImpulse.filter((r) => r.diverged).length + '/' + seeds.length)} ${col(closedImpulse.filter((r) => r.diverged).length + '/' + seeds.length)}`);
  console.log('   Neste regime o regulador nao melhora nem piora de forma material: nao ha');
  console.log('   perturbacao recorrente a rejeitar, e o custo de atuar iguala o ganho.');
  console.log('   Reportar apenas o Regime A superestimaria o beneficio.\n');

  console.log('3) RESTRICOES INVIOLAVEIS');
  const floorV = closed.reduce((a, r) => a + r.dwell_floor_violations, 0);
  const coastV = closed.reduce((a, r) => a + r.coast_violations, 0);
  console.log(`   piso de dwell (acessibilidade, 20s): ${floorV} violacoes`);
  console.log(`   teto de coasting (8%):               ${coastV} violacoes\n`);

  const improvement = 1 - avg(closed.map((r) => r.rms_error_s)) / Math.max(1, avg(open.map((r) => r.rms_error_s)));
  const impulseRatio = avg(closedImpulse.map((r) => r.rms_error_s)) / Math.max(1, avg(openImpulse.map((r) => r.rms_error_s)));
  // Criterio: melhora sob ruido continuo E nao degrada sob impulso isolado.
  const verdict = an.stable
    && closed.every((r) => !r.diverged) && closedImpulse.every((r) => !r.diverged)
    && floorV === 0 && coastV === 0
    && improvement > 0.2 && impulseRatio < 1.15;

  console.log('═══ VEREDITO ═══');
  console.log(`   analitico:  ρ = ${an.spectral_radius} < 1 → assintoticamente estavel (margem ${an.gain_margin}×)`);
  console.log(`   empirico:   ${closed.filter((r) => !r.diverged).length}/${seeds.length} sementes sem divergencia`);
  console.log(`   ruido continuo: erro RMS ${(improvement * 100).toFixed(0)}% menor que malha aberta`);
  console.log(`   impulso isolado: razao fechada/aberta = ${impulseRatio.toFixed(2)}× (limite 1.15×)`);
  console.log(`   restricoes: ${floorV + coastV === 0 ? 'nenhuma violacao' : '❌ VIOLADAS'}`);
  console.log(`\n   ${verdict ? '✅ PATAMAR ESTAVEL ATINGIDO' : '❌ NAO ATINGIDO'}\n`);

  const report = {
    generated_at: new Date().toISOString(),
    analytical: { original, tuned: an, recommended_gains: tuned },
    empirical: {
      duration_s: DURATION, disturbance_at_s: DISTURB_AT, disturbance_magnitude_s: DISTURB_MAG, seeds,
      regime_a_continuous_noise: {
        open_loop: open.map(({ samples, ...r }) => r),
        original_gains: origRun.map(({ samples, ...r }) => r),
        tuned_gains: closed.map(({ samples, ...r }) => r),
        rms_improvement_pct: Number((improvement * 100).toFixed(1)),
      },
      regime_b_single_impulse: {
        open_loop: openImpulse.map(({ samples, ...r }) => r),
        tuned_gains: closedImpulse.map(({ samples, ...r }) => r),
        closed_over_open_ratio: Number(impulseRatio.toFixed(3)),
        note: 'sem perturbacao recorrente o regulador nao tem o que rejeitar; espera-se paridade, nao ganho',
      },
    },
    constraints: { dwell_floor_violations: floorV, coast_violations: coastV },
    verdict: verdict ? 'STABLE' : 'NOT_STABLE',
    trace: closed[0]!.samples,
  };
  // O relatorio so e escrito sob --write.
  //
  // Rodar o banco e uma acao de VERIFICACAO e acontece a toda revisao; regerar
  // o artefato de evidencia e uma acao DELIBERADA. Escrever sempre fazia toda
  // verificacao sujar a arvore com ruido de medicao - latencias de relogio de
  // parede e carimbo de tempo - e poluia o historico com commits que nao mudam
  // nenhuma conclusao.
  if (process.argv.includes('--write')) {
    writeFileSync('docs/estabilidade-report.json', JSON.stringify(report, null, 2));
    console.log('   relatorio regravado: docs/estabilidade-report.json');
  } else {
    console.log('   (use --write para regravar docs/estabilidade-report.json)');
  }

  process.exit(verdict ? 0 : 1);
}

main();
