import type { TrainState } from './fleet.js';
import { allSections, getSection, lineLengthM, nominalRunTimeS, traversalTimeS } from './topology.js';

/**
 * Regulacao de headway - amortecimento de bunching.
 *
 * O bunching e instavel por realimentacao positiva: um trem atrasa, acumula
 * mais passageiros na proxima estacao, gasta mais dwell, atrasa mais, e o de
 * tras o alcanca. Corrigir so o trem atrasado nao estabiliza - e preciso agir
 * tambem no de tras, que e quem esta fechando o intervalo.
 *
 * Controle PI sobre o erro de headway. O termo derivativo foi deixado de fora
 * de proposito: a medida de headway vem de telemetria com jitter de radio, e
 * derivada de sinal ruidoso amplifica ruido, produzindo comandos de dwell que
 * oscilam a cada ciclo - desconfortavel para o passageiro e desgastante para o
 * material rodante.
 *
 * Duas restricoes sao INVIOLAVEIS e por isso ficam fora da malha, como clamp:
 *
 *  - DWELL_MIN_S: tempo minimo de porta aberta. E requisito de acessibilidade
 *    do embarque 100% em nivel na plataforma de 30 cm, nao parametro de
 *    sintonia. Nenhum ganho de pontualidade justifica fechar porta em cima de
 *    um passageiro com mobilidade reduzida.
 *  - COAST_MAX_PCT: reducao maxima por inercia (o documento estipula 4-8%).
 *    Acima disso a variacao de velocidade passa a ser percebida como solavanco.
 */

export const DWELL_MIN_S = 20;
export const DWELL_MAX_S = 90;
export const DWELL_NOMINAL_S = 30;
export const COAST_MIN_PCT = 4;
export const COAST_MAX_PCT = 8;

/** Headways de PLANEJAMENTO (quadro de horarios): ~6 min na L1, ~20 min na L2. */
export const TARGETS: Record<'L1' | 'L2', number> = { L1: 360, L2: 1200 };

export interface HeadwaySetpoint {
  /** Alvo efetivo da malha, em segundos. */
  setpoint_s: number;
  /** Alvo do quadro de horarios. */
  timetable_s: number;
  /** Melhor headway alcancavel com a frota presente. */
  feasible_s: number;
  /** Tempo de ciclo completo da linha (percurso + paradas). */
  cycle_time_s: number;
  trains: number;
  /** true quando o quadro de horarios nao e realizavel com a frota atual. */
  infeasible: boolean;
}

/**
 * Tempo de ciclo da linha: percurso a velocidade de via mais dwell nominal em
 * cada parada. E o denominador de tudo que vem a seguir.
 */
export function cycleTimeS(line: 'L1' | 'L2'): number {
  let total = 0;
  let stops = 0;
  for (const s of allSections()) {
    if (s.line !== line) continue;
    total += nominalRunTimeS(s);
    if (s.stop_id) stops += 1;
  }
  return total + stops * DWELL_NOMINAL_S;
}

/**
 * Resolve o setpoint real da malha.
 *
 * Num circuito fechado, N composicoes so conseguem sustentar um espacamento:
 * ciclo/N. Nao existe escolha aqui - e geometria, nao sintonia. O regulador
 * portanto equaliza em ciclo/N, e nao no numero do quadro de horarios.
 *
 * Perseguir o valor do quadro quando ele diverge de ciclo/N satura dwell e
 * coasting em todos os trens simultaneamente, sem nunca convergir. E o sintoma
 * classico de setpoint inalcancavel, que na operacao aparece disfarcado de
 * "o controlador esta mal sintonizado" quando o problema real e dimensionamento
 * de frota.
 *
 * Por isso a divergencia nao e erro de controle, e sinal de PLANEJAMENTO:
 *
 *   ciclo/N  >  quadro  -> frota pequena demais para a frequencia prometida
 *                          ('infeasible': o intervalo real e maior que o
 *                          anunciado ao passageiro e a agencia reguladora)
 *   ciclo/N  <= quadro  -> frota atende ou supera o quadro
 */
export function resolveSetpoint(line: 'L1' | 'L2', trainCount: number): HeadwaySetpoint {
  const cycle = cycleTimeS(line);
  const timetable = TARGETS[line];
  // Unico espacamento sustentavel com esta frota - e tambem o setpoint.
  const feasible = trainCount > 0 ? cycle / trainCount : Infinity;
  return {
    setpoint_s: Math.round(feasible),
    timetable_s: timetable,
    feasible_s: Math.round(feasible),
    cycle_time_s: Math.round(cycle),
    trains: trainCount,
    // 15% de folga antes de alarmar: a operacao real oscila em torno do quadro.
    infeasible: feasible > timetable * 1.15,
  };
}

/** Composicoes necessarias para sustentar o headway do quadro de horarios. */
export function trainsRequiredForTimetable(line: 'L1' | 'L2'): number {
  return Math.ceil(cycleTimeS(line) / TARGETS[line]);
}

export interface RegulationCommand {
  train_id: string;
  /** Dwell recomendado na proxima parada. */
  dwell_s: number;
  dwell_delta_s: number;
  /** Reducao de velocidade por inercia, em % da velocidade de via. 0 = sem coasting. */
  coast_pct: number;
  headway_error_s: number;
  /** Alvo efetivo perseguido pela malha neste ciclo. */
  setpoint_s: number;
  rationale: string;
}

interface ControllerState {
  integral: number;
  lastUpdate: number;
}

export class HeadwayRegulator {
  readonly #kp: number;
  readonly #ki: number;
  /** Limite do acumulador integral: evita windup durante bloqueio prolongado. */
  readonly #integralClampS: number;
  readonly #state = new Map<string, ControllerState>();

  /**
   * Ganhos padrao sintonizados pelo banco de estabilidade (tools/stability-bench.ts).
   *
   * Os valores originais (Kp=0.25, Ki=0.02) foram escolhidos por intuicao sobre
   * um modelo que tratava cada par de trens isoladamente. A analise modal
   * mostrou que o acoplamento circulante amplifica o ganho da malha por
   * |1 - ω^k| = √3, e naqueles ganhos o raio espectral ficava em 0.974 -
   * estavel no papel, praticamente sem margem, e empiricamente PIOR que nao
   * regular (RMS 150s contra 70s em malha aberta).
   *
   * Kp=0.51 / Ki=0.017 dao ρ=0.708 com margem de ganho de 1.72x, e reduzem o
   * erro RMS em 45% frente a malha aberta. A margem e modesta de proposito:
   * ganhos menores dariam mais folga mas convergencia lenta demais para
   * amortecer bunching antes que ele se propague pela linha.
   *
   * Reproduzir: npm run stability
   */
  constructor(kp = 0.51, ki = 0.017, integralClampS = 240) {
    this.#kp = kp;
    this.#ki = ki;
    this.#integralClampS = integralClampS;
  }

  /**
   * Calcula correcoes para uma linha inteira.
   * Trens stale sao ignorados como referencia: regular contra uma posicao que
   * pode ter minutos de idade produz correcao pior que nao corrigir.
   */
  regulate(line: 'L1' | 'L2', trains: TrainState[], now = Date.now()): RegulationCommand[] {
    const active = trains.filter((t) => !t.stale);
    if (active.length < 2) return [];

    const sp = resolveSetpoint(line, active.length);
    const target = sp.setpoint_s;
    const cmds: RegulationCommand[] = [];

    for (let i = 0; i < active.length; i++) {
      const train = active[i]!;
      // Trem imediatamente a frente, com wrap-around (a L2 e um loop).
      const ahead = active[(i + 1) % active.length]!;
      const measured = measuredHeadwayS(train, ahead, line);
      const error = measured - target; // negativo = intervalo curto = bunching

      const st = this.#state.get(train.train_id) ?? { integral: 0, lastUpdate: now };
      const dtS = Math.min(60, Math.max(1, (now - st.lastUpdate) / 1000));
      st.integral = clamp(st.integral + error * dtS * this.#ki, -this.#integralClampS, this.#integralClampS);
      st.lastUpdate = now;
      this.#state.set(train.train_id, st);

      const u = this.#kp * error + st.integral;

      // u < 0 (intervalo curto): segurar este trem -> dwell maior / coasting.
      // u > 0 (intervalo longo): apressar -> dwell menor, ate o piso.
      const rawDwell = DWELL_NOMINAL_S - u;
      const dwell = Math.round(clamp(rawDwell, DWELL_MIN_S, DWELL_MAX_S));

      let coast = 0;
      let rationale: string;
      if (error < -60 && dwell >= DWELL_MAX_S) {
        // Dwell ja saturou e o intervalo continua curto: o restante da correcao
        // sai como coasting, que ainda economiza energia em vez de frear.
        const excess = Math.min(1, (-error - 60) / 180);
        coast = Math.round(COAST_MIN_PCT + excess * (COAST_MAX_PCT - COAST_MIN_PCT));
        rationale = `Intervalo ${Math.round(measured)}s contra setpoint ${target}s. Dwell saturado em ${dwell}s; aplicando coasting de ${coast}% para dissipar o excedente sem frenagem.`;
      } else if (error < 0) {
        rationale = `Intervalo curto (${Math.round(measured)}s, setpoint ${target}s): prolongando dwell para ${dwell}s e recompondo o espacamento.`;
      } else if (dwell <= DWELL_MIN_S && error > 30) {
        rationale = `Intervalo longo (${Math.round(measured)}s): dwell no piso de acessibilidade (${DWELL_MIN_S}s). Correcao adicional exige ajuste de tabela, nao de parada.`;
      } else {
        rationale = `Intervalo ${Math.round(measured)}s dentro da tolerancia; dwell ${dwell}s.`;
      }

      cmds.push({
        train_id: train.train_id,
        dwell_s: dwell,
        dwell_delta_s: dwell - DWELL_NOMINAL_S,
        coast_pct: coast,
        headway_error_s: Math.round(error),
        setpoint_s: target,
        rationale,
      });
    }
    return cmds;
  }

  /** Zera o integrador - usado quando a linha e reconfigurada apos incidente. */
  reset(trainId?: string): void {
    if (trainId) this.#state.delete(trainId);
    else this.#state.clear();
  }
}

/**
 * Headway medido: tempo de separacao ate o trem da frente.
 *
 * Inclui os dwells das paradas intermediarias, porque o setpoint (ciclo/N)
 * tambem os inclui - medicao e referencia precisam estar na mesma base. Medir
 * so distancia/velocidade produzia um erro negativo sistematico igual ao dwell
 * total da linha, e a malha divergia com todos os trens no dwell maximo.
 *
 * Usa velocidade de VIA e nao a instantanea: um trem parado na estacao tem
 * velocidade zero, e dividir por ela produziria headway infinito.
 */
function measuredHeadwayS(train: TrainState, ahead: TrainState, line: 'L1' | 'L2'): number {
  let gap = ahead.linear_pos_m - train.linear_pos_m;
  if (gap <= 0) gap += lineLengthM(line); // wrap no loop
  return traversalTimeS(line, train.linear_pos_m, gap, DWELL_NOMINAL_S);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export { nominalRunTimeS };
