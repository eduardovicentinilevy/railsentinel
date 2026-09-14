import type { IntegrityClass } from '@railsentinel/contracts';

/**
 * SafetyGuard - a particao EN 50716 tornada executavel.
 *
 * A norma permite que funcoes de Integridade Basica (a IA de visao
 * computacional do Jetson) convivam com funcoes vitais SIL 2/4 desde que a
 * segregacao seja demonstravel. Numa revisao de certificacao, "o codigo nao faz
 * isso" e uma afirmacao fraca; "existe um ponto unico que recusa e registra
 * toda tentativa" e uma evidencia.
 *
 * Regra: a autoridade de um efeito nunca pode exceder a classe de integridade
 * da evidencia que o motivou.
 *
 *   basic -> pode ELEVAR alarme, ACONSELHAR restricao, RETIRAR prioridade
 *   basic -> NUNCA comandar freio, conceder rota, liberar intertravamento
 *
 * O ponto sutil e o TSP: retirar um pedido de prioridade e permitido a
 * Integridade Basica porque so REMOVE uma acao permissiva. O pior caso de uma
 * retirada equivocada e um VLT parando num sinal que poderia estar verde -
 * perda de desempenho, nunca perda de seguranca. Conceder prioridade e o
 * oposto: cria permissao, e portanto fica fora do alcance da IA.
 */

export type EffectKind =
  | 'raise_alarm'
  | 'advisory_speed_limit'
  | 'advisory_hold'
  | 'revoke_tsp_request'
  | 'adjust_dwell_time'
  | 'publish_service_alert'
  | 'grant_tsp_request'
  | 'command_emergency_brake'
  | 'set_interlocking_route'
  | 'release_route_lock'
  | 'override_atp';

/** Autoridade minima exigida por efeito. */
const REQUIRED_AUTHORITY: Record<EffectKind, IntegrityClass> = {
  raise_alarm: 'basic',
  advisory_speed_limit: 'basic',
  advisory_hold: 'basic',
  revoke_tsp_request: 'basic',
  adjust_dwell_time: 'basic',
  publish_service_alert: 'basic',

  grant_tsp_request: 'sil2',
  set_interlocking_route: 'sil4',
  release_route_lock: 'sil4',
  command_emergency_brake: 'sil4',
  override_atp: 'sil4',
};

const RANK: Record<IntegrityClass, number> = { basic: 0, sil2: 1, sil4: 2 };

export interface SafetyViolation {
  at: string;
  effect: EffectKind;
  evidence_class: IntegrityClass;
  required_class: IntegrityClass;
  source_event_id: string;
  rationale: string;
}

export interface GuardDecision {
  permitted: boolean;
  violation?: SafetyViolation;
}

export class SafetyGuard {
  readonly #violations: SafetyViolation[] = [];
  #onViolation?: (v: SafetyViolation) => void;

  onViolation(fn: (v: SafetyViolation) => void): void {
    this.#onViolation = fn;
  }

  /**
   * Unico caminho pelo qual o ats-core pode produzir um efeito.
   * Chamar diretamente o atuador sem passar por aqui e o que a revisao de
   * codigo e os testes de particao procuram.
   */
  authorize(effect: EffectKind, evidenceClass: IntegrityClass, sourceEventId: string): GuardDecision {
    const required = REQUIRED_AUTHORITY[effect];
    if (RANK[evidenceClass] >= RANK[required]) {
      return { permitted: true };
    }
    const violation: SafetyViolation = {
      at: new Date().toISOString(),
      effect,
      evidence_class: evidenceClass,
      required_class: required,
      source_event_id: sourceEventId,
      rationale:
        `Efeito '${effect}' exige integridade ${required}; a evidencia e de classe ` +
        `${evidenceClass}. EN 50716: funcao de Integridade Basica nao adquire ` +
        `autoridade vital por confianca alta do modelo.`,
    };
    this.#violations.push(violation);
    this.#onViolation?.(violation);
    return { permitted: false, violation };
  }

  get violations(): readonly SafetyViolation[] {
    return this.#violations;
  }
}
