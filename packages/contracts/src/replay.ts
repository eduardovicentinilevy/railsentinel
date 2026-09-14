/**
 * Defesa contra replay e duplicata.
 *
 * MQTT QoS 1 entrega ao menos uma vez: duplicata e comportamento normal, nao
 * ataque - por isso a deduplicacao por id vem antes de qualquer suspeita.
 * Replay e outra coisa: reinjetar um 'cleared' capturado antes reabriria uma
 * via que continua obstruida.
 *
 * O caso dificil nao e o ataque, e o reinicio legitimo. Um no que reinicia zera
 * o contador de sequencia, e um guard que so olha 'seq' nao consegue separar
 * "o Jetson rebootou" de "alguem esta reinjetando trafego antigo" - e escolher
 * entre bloquear um no recem-reiniciado ou aceitar replay nao tem resposta boa.
 *
 * A saida e a mesma do Sparkplug B com seu bdSeq: um identificador de SESSAO DE
 * BOOT no envelope. 'seq' e monotonico dentro de um boot; um boot novo zera a
 * contagem, mas precisa ser estritamente maior que o ultimo visto. Assim:
 *
 *   boot maior   -> reinicio legitimo, contagem reiniciada
 *   boot igual   -> seq tem de avancar
 *   boot menor   -> sessao antiga reinjetada: recusado
 *
 * Quatro barreiras, todas baratas, nenhuma suficiente sozinha:
 *   1. janela de frescor - ts fora de +-skew e descartado
 *   2. sessao de boot    - sessao anterior nao volta
 *   3. seq monotonico    - dentro da sessao, seq nao regride
 *   4. cache de ids      - (src,id) ja visto e duplicata
 */

export type RejectReason = 'stale' | 'future' | 'stale_boot' | 'replayed_seq' | 'duplicate';

export interface ReplayVerdict {
  accept: boolean;
  reason?: RejectReason;
  detail?: string;
  /** true quando a origem reiniciou desde a ultima mensagem vista. */
  rebooted?: boolean;
}

export interface ReplayGuardOptions {
  /** Idade maxima aceita, em ms. */
  maxAgeMs?: number;
  /** Tolerancia para relogio adiantado, em ms. */
  maxSkewMs?: number;
  /** Quantos ids recentes reter por origem. */
  idCacheSize?: number;
}

export interface CheckInput {
  src: string;
  id: string;
  seq: number;
  boot: number;
  ts: string;
}

interface SourceState {
  boot: number;
  lastSeq: number;
  seenIds: Set<string>;
  idOrder: string[];
}

export class ReplayGuard {
  readonly #maxAgeMs: number;
  readonly #maxSkewMs: number;
  readonly #idCacheSize: number;
  readonly #sources = new Map<string, SourceState>();

  constructor(opts: ReplayGuardOptions = {}) {
    this.#maxAgeMs = opts.maxAgeMs ?? 30_000;
    this.#maxSkewMs = opts.maxSkewMs ?? 5_000;
    this.#idCacheSize = opts.idCacheSize ?? 512;
  }

  check(input: CheckInput, now = Date.now()): ReplayVerdict {
    const { src, id, seq, boot, ts } = input;

    const sentAt = Date.parse(ts);
    if (Number.isNaN(sentAt)) return { accept: false, reason: 'stale', detail: 'ts ilegivel' };

    const age = now - sentAt;
    if (age > this.#maxAgeMs) {
      return { accept: false, reason: 'stale', detail: `${age}ms de idade (max ${this.#maxAgeMs}ms)` };
    }
    if (age < -this.#maxSkewMs) {
      return { accept: false, reason: 'future', detail: `${-age}ms no futuro (max ${this.#maxSkewMs}ms)` };
    }

    let st = this.#sources.get(src);
    if (!st) {
      st = { boot, lastSeq: -1, seenIds: new Set(), idOrder: [] };
      this.#sources.set(src, st);
    }

    // O cache de ids vem antes da logica de sessao: uma reentrega de QoS 1 e
    // duplicata, e rotula-la como ataque poluiria a trilha de auditoria.
    if (st.seenIds.has(id)) {
      return { accept: false, reason: 'duplicate', detail: `id ${id} ja processado` };
    }

    let rebooted = false;
    if (boot > st.boot) {
      // Reinicio legitimo: nova sessao, contagem recomeca.
      st.boot = boot;
      st.lastSeq = -1;
      rebooted = true;
    } else if (boot < st.boot) {
      return { accept: false, reason: 'stale_boot', detail: `sessao ${boot} anterior a ${st.boot}` };
    } else if (seq <= st.lastSeq) {
      return { accept: false, reason: 'replayed_seq', detail: `seq ${seq} <= ultimo ${st.lastSeq} na sessao ${boot}` };
    }

    st.lastSeq = seq;
    st.seenIds.add(id);
    st.idOrder.push(id);
    if (st.idOrder.length > this.#idCacheSize) {
      const evicted = st.idOrder.shift();
      if (evicted) st.seenIds.delete(evicted);
    }
    return { accept: true, ...(rebooted ? { rebooted: true } : {}) };
  }

  /**
   * Lacunas de seq indicam perda de pacote: sintoma de radio degradado.
   * Nao conta na troca de sessao, onde a descontinuidade e esperada.
   */
  gapCount(src: string, seq: number, boot: number): number {
    const st = this.#sources.get(src);
    if (!st || st.lastSeq < 0 || st.boot !== boot) return 0;
    return Math.max(0, seq - st.lastSeq - 1);
  }
}
