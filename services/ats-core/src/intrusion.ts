import {
  uuidv7, shortId,
  type IntrusionData, type Message, type OperatorAlarm, type TrackRestriction, type TspDecision,
} from '@railsentinel/contracts';
import { getSection, upstreamOf } from './topology.js';
import type { FleetRegistry, TrainState } from './fleet.js';
import type { SafetyGuard } from './safety-guard.js';
import type { TspController } from './tsp.js';

/**
 * Tratamento de invasao de via.
 *
 * Este e o caminho critico do sistema: da deteccao no Jetson ate o painel do
 * operador. Tres decisoes de projeto merecem destaque, porque sao as que
 * separam um demo de um sistema defensavel numa auditoria:
 *
 * 1. NADA aqui comanda freio. A evidencia e de classe 'basic' (EN 50716) e o
 *    SafetyGuard recusa qualquer efeito vital. O que o sistema faz e reduzir o
 *    tempo de reacao HUMANA de dezenas de segundos para menos de um, alem de
 *    retirar prioridade semaforica - que e uma acao de remocao, nao de
 *    concessao, e portanto segura mesmo se o modelo estiver errado.
 *
 * 2. O limiar de confianca varia com a consequencia, nao com o modelo. Pessoa
 *    na via a 25 km/h em via compartilhada e tratada com limiar mais baixo que
 *    detrito em trecho segregado: o custo de um falso negativo e
 *    incomparavelmente maior que o de um falso positivo, e o limiar deve
 *    refletir a assimetria, nao a acuracia media do detector.
 *
 * 3. 'cleared' vindo do campo NUNCA levanta a restricao sozinho. Ele apenas
 *    marca a ocorrencia como candidata a liberacao, e o operador confirma.
 *    Fosse automatico, um unico 'cleared' forjado ou um falso negativo do
 *    modelo reabriria uma via ainda obstruida - exatamente o modo de falha que
 *    a arquitetura existe para impedir.
 */

/** Limiar de confianca por classe de objeto, ponderado pela consequencia. */
const CONFIDENCE_THRESHOLD: Record<string, number> = {
  person: 0.45,
  bicycle: 0.50,
  motorcycle: 0.55,
  car: 0.60,
  truck: 0.60,
  animal: 0.55,
  debris: 0.70,
  unknown: 0.75,
};

/** Persistencia minima para descartar deteccao de quadro isolado. */
const MIN_DWELL_MS = 400;

export interface IntrusionOutcome {
  accepted: boolean;
  /**
   * Discrimina o desfecho. 'clear_candidate' nao e um incidente novo: e a
   * borda reportando normalizacao, que fica pendente de confirmacao humana.
   * Sem esta distincao o log trata as duas coisas como a mesma, e quem le o
   * historico de um incidente ve "INCIDENTE processado" onde na verdade houve
   * um pedido de liberacao.
   */
  kind: 'incident' | 'clear_candidate' | 'filtered';
  reason?: string;
  alarm?: OperatorAlarm;
  restriction?: TrackRestriction;
  tspRevocations: TspDecision[];
  affectedTrains: TrainState[];
  incident_id: string;
}

export class IntrusionHandler {
  readonly #guard: SafetyGuard;
  readonly #fleet: FleetRegistry;
  readonly #tsp: TspController;
  /** Incidentes abertos por secao, para correlacionar onset/sustained/cleared. */
  readonly #open = new Map<string, { incident_id: string; restriction_id: string; alarm_id: string; crossings: string[] }>();

  constructor(guard: SafetyGuard, fleet: FleetRegistry, tsp: TspController) {
    this.#guard = guard;
    this.#fleet = fleet;
    this.#tsp = tsp;
  }

  handle(msg: Message<IntrusionData>, now = new Date()): IntrusionOutcome {
    const { env, data } = msg;
    const sectionId = data.track.section_id;
    const existing = this.#open.get(sectionId);
    const incident_id = existing?.incident_id ?? shortId('INC');

    const base: IntrusionOutcome = { accepted: false, kind: 'filtered', tspRevocations: [], affectedTrains: [], incident_id };

    // --- Filtro 1: confianca ponderada pela consequencia ---
    const threshold = CONFIDENCE_THRESHOLD[data.object.class] ?? 0.75;
    if (data.object.conf < threshold) {
      return { ...base, reason: `confianca ${data.object.conf.toFixed(2)} abaixo do limiar ${threshold} para classe '${data.object.class}'` };
    }

    const section = getSection(sectionId);
    if (!section) {
      return { ...base, reason: `secao ${sectionId} desconhecida na topologia` };
    }

    // --- Liberacao: candidata, nunca automatica ---
    // Avaliada ANTES do filtro de persistencia: um 'cleared' chega com dwell 0
    // por natureza (a condicao acabou de deixar de existir), e trata-lo como
    // deteccao transitoria descartaria silenciosamente a unica pista de que a
    // via pode ter normalizado.
    if (data.state === 'cleared') {
      return {
        ...base,
        accepted: true,
        kind: 'clear_candidate',
        reason: 'condicao reportada como normalizada pela borda; restricao mantida ate confirmacao do operador',
        alarm: this.#buildAlarm(env, data, section.name, incident_id, 'warning',
          `Via aparentemente desobstruida em ${section.name}`,
          `O no de borda reporta que o objeto '${data.object.class}' deixou o gabarito. A restricao PERMANECE ativa. Confirme visualmente pelo CFTV antes de liberar.`,
          ['Revisar imagem ao vivo do cruzamento', 'Confirmar liberacao da secao', 'Manter restricao']),
      };
    }

    // --- Filtro 2: persistencia ---
    // Pulado quando ha urgencia: pessoa na via ou objeto ja dentro do gabarito
    // nao espera confirmacao de quadros. Nesses casos o custo de um falso
    // positivo (um alarme a mais) e desprezivel frente ao de um falso negativo.
    const dwell = data.dwell_ms ?? 0;
    const urgent = data.object.class === 'person' || (data.track.gauge_margin_m ?? 1) < 0;
    if (!urgent && dwell < MIN_DWELL_MS) {
      return { ...base, reason: `persistencia de ${dwell}ms abaixo do minimo de ${MIN_DWELL_MS}ms` };
    }

    // --- Efeito 1: alarme ao operador (autoridade basic - permitido) ---
    if (!this.#guard.authorize('raise_alarm', env.class, env.id).permitted) {
      return { ...base, reason: 'SafetyGuard recusou levantar alarme' };
    }

    const severity = urgent ? 'critical' : 'major';
    const alarm = this.#buildAlarm(env, data, section.name, incident_id, severity,
      `Invasao de gabarito: ${ptClass(data.object.class)} em ${section.name}`,
      `Deteccao de ${ptClass(data.object.class)} no gabarito dinamico da secao ${sectionId}` +
        (data.track.chainage_m != null ? `, estaca ${Math.round(data.track.chainage_m)} m` : '') +
        (data.track.gauge_margin_m != null && data.track.gauge_margin_m < 0
          ? `, ja ${Math.abs(data.track.gauge_margin_m).toFixed(2)} m dentro do gabarito` : '') + '.',
      ['Acionar CFTV do trecho', 'Contatar operadores das composicoes a montante', 'Acionar CET-Santos se houver veiculo na via', 'Confirmar restricao de velocidade']);

    // --- Efeito 2: restricao ADVISORY (sem autoridade de frenagem) ---
    let restriction: TrackRestriction | undefined;
    if (this.#guard.authorize('advisory_speed_limit', env.class, env.id).permitted) {
      const limit = urgent ? 0 : Math.min(15, Math.round(section.line_speed_kmh * 0.4));
      restriction = {
        restriction_id: existing?.restriction_id ?? shortId('TSR'),
        section_id: sectionId,
        kind: limit === 0 ? 'advisory_hold' : 'advisory_speed_limit',
        ...(limit > 0 ? { speed_limit_kmh: limit } : {}),
        reason: `Invasao de gabarito detectada por visao computacional (${data.detector.model} v${data.detector.model_version}, confianca ${(data.object.conf * 100).toFixed(0)}%). Incidente ${incident_id}.`,
        origin_class: env.class,
        issued_at: now.toISOString(),
        expires_at: new Date(now.getTime() + 30 * 60_000).toISOString(),
        requires_operator_ack: true,
        source_event_id: env.id,
      };
    }

    // --- Efeito 3: retirar prioridade semaforica a montante ---
    // Acao de REMOCAO: nao concede movimento, so deixa de pedir verde. Por isso
    // e admissivel sob evidencia de Integridade Basica.
    const upstream = upstreamOf(sectionId, 2);
    const crossings = [section, ...upstream].map((s) => s.crossing_id).filter((c): c is string => Boolean(c));
    const tspRevocations: TspDecision[] = [];
    for (const crossingId of new Set(crossings)) {
      const ok = this.#tsp.inhibit(crossingId, `incidente ${incident_id} na secao ${sectionId}`, env.class, env.id);
      if (ok) {
        tspRevocations.push({
          crossing_id: crossingId,
          train_id: '*',
          action: 'revoke',
          reason: `Prioridade suspensa: obstrucao a jusante na secao ${sectionId}. Sem pedido de verde, as composicoes param no sinal antes da obstrucao.`,
          decided_at: now.toISOString(),
        });
      }
    }

    // --- Conjunto de risco: quem ainda vai chegar na obstrucao ---
    const affectedTrains = this.#fleet.inSections([sectionId, ...upstream.map((s) => s.id)]);

    this.#open.set(sectionId, {
      incident_id,
      restriction_id: restriction?.restriction_id ?? '',
      alarm_id: alarm.alarm_id,
      crossings: [...new Set(crossings)],
    });

    return { accepted: true, kind: 'incident', incident_id, alarm, ...(restriction ? { restriction } : {}), tspRevocations, affectedTrains };
  }

  /** Liberacao confirmada pelo operador - unico caminho que reabre a secao. */
  operatorClear(sectionId: string): { released: boolean; crossings: string[] } {
    const open = this.#open.get(sectionId);
    if (!open) return { released: false, crossings: [] };
    for (const c of open.crossings) this.#tsp.release(c);
    this.#open.delete(sectionId);
    return { released: true, crossings: open.crossings };
  }

  openIncidents(): string[] {
    return [...this.#open.keys()];
  }

  #buildAlarm(
    env: Message['env'], data: IntrusionData, sectionName: string, incidentId: string,
    severity: OperatorAlarm['severity'], title: string, detail: string, actions: string[],
  ): OperatorAlarm {
    return {
      alarm_id: uuidv7(),
      severity,
      title,
      detail: `${detail} Incidente ${incidentId}. Trecho: ${sectionName}.`,
      section_id: data.track.section_id,
      ...(env.zone ? { zone: env.zone } : {}),
      ...(env.line ? { line: env.line } : {}),
      raised_at: new Date().toISOString(),
      acknowledged: false,
      // A IHM exibe esta proveniencia ao lado do alarme. O operador precisa
      // saber que a origem e um modelo de IA sem autoridade vital, e nao um
      // circuito de via - isso muda como ele pondera a informacao.
      provenance: {
        integrity_class: env.class,
        source: env.src,
        confidence: data.object.conf,
        model: `${data.detector.model} v${data.detector.model_version}`,
      },
      ...(data.evidence?.ref ? { evidence_ref: data.evidence.ref } : {}),
      actions,
    };
  }
}

function ptClass(c: string): string {
  const map: Record<string, string> = {
    car: 'automovel', truck: 'caminhao', motorcycle: 'motocicleta', bicycle: 'bicicleta',
    person: 'pedestre', animal: 'animal', debris: 'detrito', unknown: 'objeto nao classificado',
  };
  return map[c] ?? c;
}
