import type { TspDecision } from '@railsentinel/contracts';
import type { TrainState } from './fleet.js';
import { getCrossing, getSection } from './topology.js';
import type { SafetyGuard } from './safety-guard.js';

/**
 * Transit Signal Priority sobre NTCIP 1202.
 *
 * O CCO atua como Priority Request Server perante os controladores da
 * CET-Santos. O que torna o esquema ADAPTATIVO e o portao de elegibilidade: so
 * se pede prioridade para composicao ATRASADA. Um VLT adiantado que recebe onda
 * verde chega ainda mais cedo, o que nao melhora a pontualidade e apenas
 * transfere atraso para o trafego transversal - que inclui as linhas de onibus
 * municipais. Prioridade concedida sem criterio degrada a rede inteira e queima
 * o acordo politico com o orgao de transito, que e o ativo mais dificil de
 * recuperar num projeto destes.
 *
 * As tres estrategias da norma:
 *   phase_call      - chamar a fase verde do movimento longitudinal do VLT
 *   green_extension - esticar o verde ja ativo para o VLT concluir a travessia
 *   red_truncation  - abreviar o ciclo transversal e antecipar a fase do VLT
 */

export const MIN_DELAY_FOR_PRIORITY_S = 45;
/** Horizonte de predicao: pedido cedo demais expira, tarde demais nao rende. */
export const REQUEST_HORIZON_S = 25;
/** Teto de extensao de verde para nao esfomear o movimento transversal. */
export const MAX_GREEN_EXTENSION_S = 10;
/** Janela em que um novo pedido para o mesmo cruzamento e suprimido. */
export const REQUEST_DEBOUNCE_MS = 20_000;
/** Folga aceita entre o verde previsto e o ETA antes de pedir prioridade. */
export const GREEN_MARGIN_S = 3;

export interface TspEvaluation {
  decision: TspDecision | null;
  eta_s?: number;
  request_id?: string;
  skipped_reason?: string;
}

export interface NtcipCommand {
  endpoint: string;
  /** Objetos MIB do NTCIP 1202 tocados por este comando. */
  mib_objects: Record<string, number | string>;
  strategy: 'phase_call' | 'green_extension' | 'red_truncation';
}

/** Estado realimentado pelo controlador de trafego (HIL / campo). */
export interface CrossingFeedback {
  crossing_id: string;
  active_phase: number;
  color: 'green' | 'yellow' | 'all_red';
  seconds_until_vlt_green: number;
  granted_extension_s: number;
  cross_street_debt_s: number;
  at: number;
}

export interface GrantResult {
  crossing_id: string;
  request_id: string;
  granted: boolean;
  reason?: string;
  effect?: string;
  delaySeconds?: number;
}

export class TspController {
  readonly #guard: SafetyGuard;
  /** Cruzamentos com prioridade suspensa por incidente. */
  readonly #inhibited = new Map<string, string>();
  /** Ultimo estado conhecido de cada controlador - a realimentacao da malha. */
  readonly #feedback = new Map<string, CrossingFeedback>();
  /** Pedido em voo por cruzamento, com o instante de emissao. */
  readonly #inFlight = new Map<string, { request_id: string; at: number; train_id: string }>();
  /** Historico de desfechos, para medir convergencia e fome do transversal. */
  readonly #outcomes: GrantResult[] = [];

  constructor(guard: SafetyGuard) {
    this.#guard = guard;
  }

  /** Absorve o estado publicado pelo controlador semaforico. */
  observe(fb: CrossingFeedback): void {
    this.#feedback.set(fb.crossing_id, fb);
  }

  feedbackFor(crossingId: string): CrossingFeedback | undefined {
    return this.#feedback.get(crossingId);
  }

  recordOutcome(result: GrantResult): void {
    this.#outcomes.push(result);
    if (this.#outcomes.length > 500) this.#outcomes.shift();
    this.#inFlight.delete(result.crossing_id);
  }

  get outcomes(): readonly GrantResult[] { return this.#outcomes; }

  /** Fracao de pedidos atendidos - indicador de saude do TSP. */
  grantRate(): number {
    if (this.#outcomes.length === 0) return 0;
    return this.#outcomes.filter((o) => o.granted).length / this.#outcomes.length;
  }

  /**
   * Suspende prioridade num cruzamento.
   *
   * Chamado quando ha invasao de via a jusante. Permitido a evidencia de
   * Integridade Basica porque RETIRA permissao: no pior caso o VLT para num
   * sinal que poderia estar verde. Nunca cria movimento.
   */
  inhibit(crossingId: string, reason: string, evidenceClass: 'basic' | 'sil2' | 'sil4', sourceEventId: string): boolean {
    const ok = this.#guard.authorize('revoke_tsp_request', evidenceClass, sourceEventId);
    if (!ok.permitted) return false;
    this.#inhibited.set(crossingId, reason);
    return true;
  }

  release(crossingId: string): void {
    this.#inhibited.delete(crossingId);
  }

  isInhibited(crossingId: string): boolean {
    return this.#inhibited.has(crossingId);
  }

  inhibitions(): Array<{ crossing_id: string; reason: string }> {
    return [...this.#inhibited.entries()].map(([crossing_id, reason]) => ({ crossing_id, reason }));
  }

  /**
   * Avalia se vale pedir prioridade para uma composicao.
   * Conceder e efeito de classe sil2 - o guard barra se a evidencia for basic.
   */
  evaluate(train: TrainState, evidenceClass: 'basic' | 'sil2' | 'sil4', sourceEventId: string): TspEvaluation {
    const section = getSection(train.section_id);
    if (!section?.crossing_id) return { decision: null, skipped_reason: 'secao sem cruzamento semaforico' };

    const crossing = getCrossing(section.crossing_id);
    if (!crossing) return { decision: null, skipped_reason: 'cruzamento nao cadastrado' };

    if (this.#inhibited.has(crossing.id)) {
      return { decision: null, skipped_reason: `prioridade suspensa: ${this.#inhibited.get(crossing.id)}` };
    }

    if (train.stale) {
      return { decision: null, skipped_reason: 'telemetria obsoleta - nao se pede fase com posicao incerta' };
    }

    // Um pedido ja em voo para este cruzamento. Reemitir a cada atualizacao de
    // posicao - que chegam a 1 Hz - inundaria o controlador com pedidos
    // redundantes e, pior, produziria oscilacao: cada novo pedido reescreve a
    // chamada de fase e o controlador nunca conclui a transicao. Este gate e o
    // que mantem a malha estavel; sem ele o TSP nao converge.
    const flight = this.#inFlight.get(crossing.id);
    if (flight && Date.now() - flight.at < REQUEST_DEBOUNCE_MS) {
      return { decision: null, skipped_reason: `pedido ${flight.request_id} ainda em voo para ${crossing.id}` };
    }

    // Realimentacao: se o controlador ja vai dar verde a tempo, nao se pede
    // nada. Pedir prioridade que nao muda o resultado so gasta credito politico
    // com o orgao de transito.
    const fb = this.#feedback.get(crossing.id);

    const delay = train.schedule_dev_s ?? 0;
    if (delay < MIN_DELAY_FOR_PRIORITY_S) {
      return {
        decision: null,
        skipped_reason: delay <= 0
          ? `composicao adiantada em ${-delay}s: prioridade cedida ao trafego transversal`
          : `atraso de ${delay}s abaixo do limiar de ${MIN_DELAY_FOR_PRIORITY_S}s`,
      };
    }

    const remaining_m = section.length_m - (train.chainage_m ?? 0);
    const speed = Math.max(5, train.speed_kmh);
    const eta_s = (remaining_m / 1000 / speed) * 3600;

    if (eta_s > REQUEST_HORIZON_S) {
      return { decision: null, eta_s, skipped_reason: `ETA de ${Math.round(eta_s)}s alem do horizonte de ${REQUEST_HORIZON_S}s` };
    }

    if (fb && fb.seconds_until_vlt_green <= eta_s + GREEN_MARGIN_S) {
      return {
        decision: null, eta_s,
        skipped_reason: `controlador ja da verde em ${fb.seconds_until_vlt_green}s (ETA ${Math.round(eta_s)}s) - prioridade desnecessaria`,
      };
    }

    const authorized = this.#guard.authorize('grant_tsp_request', evidenceClass, sourceEventId);
    if (!authorized.permitted) {
      return { decision: null, eta_s, skipped_reason: 'barrado pelo SafetyGuard: evidencia de Integridade Basica nao concede prioridade' };
    }

    // A estrategia depende do ESTADO REAL do controlador, nao apenas do ETA.
    // Pedir extensao de verde com a fase em vermelho e um pedido que o
    // controlador vai recusar - e uma recusa evitavel e desperdicio de ciclo.
    let strategy: 'phase_call' | 'green_extension' | 'red_truncation';
    if (fb?.color === 'green' && fb.active_phase === crossing.vlt_phase) {
      strategy = 'green_extension';
    } else if (eta_s < 15) {
      strategy = 'red_truncation';
    } else {
      strategy = 'phase_call';
    }

    const requestId = `${train.train_id}-${Date.now().toString(36)}`;
    this.#inFlight.set(crossing.id, { request_id: requestId, at: Date.now(), train_id: train.train_id });

    return {
      eta_s,
      request_id: requestId,
      decision: {
        crossing_id: crossing.id,
        train_id: train.train_id,
        action: 'request_grant',
        ntcip_strategy: strategy,
        reason: `Composicao ${train.train_id} atrasada em ${delay}s, ETA ${Math.round(eta_s)}s no cruzamento ${crossing.name}.`,
        decided_at: new Date().toISOString(),
      },
    };
  }

  /**
   * Traduz a decisao para objetos MIB do NTCIP 1202.
   *
   * ESTADO ATUAL: malha ABERTA. Os objetos MIB sao gerados e registrados, mas
   * nao ha transporte SNMP nem emulador de controlador respondendo - portanto
   * nao ha realimentacao de estado de fase e nenhuma estabilidade de TSP foi
   * demonstrada. O emulador em malha fechada (HIL) exigido pela Fase 1 do
   * roadmap ainda nao existe; ver docs/ARQUITETURA.md, secao de limites.
   *
   * A traducao e funcao pura e separada da elegibilidade justamente para que
   * fechar a malha - contra emulador agora, contra o controlador da CET-Santos
   * depois - nao exija mudanca na camada de decisao.
   */
  toNtcip(decision: TspDecision): NtcipCommand | null {
    const crossing = getCrossing(decision.crossing_id);
    if (!crossing) return null;

    const base = {
      'priorityRequestServer.prsControlPlan': 1,
      'priorityRequest.priorityRequestPhase': crossing.vlt_phase,
      'priorityRequest.priorityRequestVehicleClass': 6, // classe 6 = transporte sobre trilhos
      'priorityRequest.priorityRequestID': decision.train_id,
    };

    switch (decision.ntcip_strategy) {
      case 'green_extension':
        return { endpoint: crossing.ntcip_endpoint, strategy: 'green_extension', mib_objects: { ...base, 'phaseTable.phaseMaxGreenExtension': MAX_GREEN_EXTENSION_S, 'priorityRequest.priorityRequestStrategyNumber': 2 } };
      case 'red_truncation':
        return { endpoint: crossing.ntcip_endpoint, strategy: 'red_truncation', mib_objects: { ...base, 'phaseTable.phaseForceOff': 1, 'priorityRequest.priorityRequestStrategyNumber': 3 } };
      default:
        return { endpoint: crossing.ntcip_endpoint, strategy: 'phase_call', mib_objects: { ...base, 'phaseControl.phaseCall': crossing.vlt_phase, 'priorityRequest.priorityRequestStrategyNumber': 1 } };
    }
  }
}
