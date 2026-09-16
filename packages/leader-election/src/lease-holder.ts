import type { Pool } from 'pg';
import { LeaderElection } from './election.js';

/**
 * Orquestra o ciclo de tentativa/renovacao/perda de lideranca, para que um
 * servico nao precise reimplementar timing de retry a cada uso do
 * LeaderElection primitivo.
 *
 * Fail-visible por design: 'onChange' dispara tanto ao ADQUIRIR quanto ao
 * PERDER a lideranca, e o servico chamador (ats-core) usa isso para parar de
 * publicar em standby - nunca para continuar publicando "torcendo" para ainda
 * ser lider. Perder a lideranca e estado normal e esperado (failover), nao
 * excecao.
 */

export interface LeaseHolderOptions {
  /** Duracao do lease. Curto o bastante para failover rapido; longo o
   * bastante para que jitter de rede normal nao cause perda espuria. */
  leaseDurationMs?: number;
  /** Intervalo de renovacao enquanto lider - deve ser bem menor que o lease
   * (1/3 por padrao) para tolerar uma renovacao perdida sem cair. */
  renewIntervalMs?: number;
  /** Intervalo de nova tentativa enquanto em standby. */
  retryIntervalMs?: number;
}

export type LeadershipListener = (state: { isLeader: boolean; epoch: number | null }) => void;

export class LeaseHolder {
  readonly #election: LeaderElection;
  readonly #leaseDurationMs: number;
  readonly #renewIntervalMs: number;
  readonly #retryIntervalMs: number;
  #epoch: number | null = null;
  #timer: NodeJS.Timeout | null = null;
  #stopped = false;
  #listeners: LeadershipListener[] = [];
  /**
   * Sem isto, uma instancia que nasce em standby e PERMANECE em standby nunca
   * dispara onChange - a transicao e de null para null, tecnicamente "sem
   * mudanca". Um operador olhando o log dessa instancia veria silencio total
   * e nao teria como distinguir "esta viva e corretamente em standby" de
   * "travou antes de sequer tentar". A primeira avaliacao sempre notifica,
   * seja qual for o resultado.
   */
  #everNotified = false;

  constructor(pool: Pool, role: string, holderId: string, opts: LeaseHolderOptions = {}) {
    this.#election = new LeaderElection(pool, role, holderId);
    this.#leaseDurationMs = opts.leaseDurationMs ?? 15_000;
    this.#renewIntervalMs = opts.renewIntervalMs ?? this.#leaseDurationMs / 3;
    this.#retryIntervalMs = opts.retryIntervalMs ?? 2_000;
  }

  onChange(fn: LeadershipListener): void {
    this.#listeners.push(fn);
  }

  isLeader(): boolean {
    return this.#epoch !== null;
  }

  epoch(): number | null {
    return this.#epoch;
  }

  start(): void {
    this.#stopped = false;
    void this.#tick();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    if (this.#epoch !== null) {
      await this.#election.release(this.#epoch);
      this.#setEpoch(null);
    }
  }

  #setEpoch(next: number | null): void {
    const changed = next !== this.#epoch || !this.#everNotified;
    this.#epoch = next;
    this.#everNotified = true;
    if (changed) {
      for (const fn of this.#listeners) fn({ isLeader: next !== null, epoch: next });
    }
  }

  async #tick(): Promise<void> {
    if (this.#stopped) return;

    try {
      if (this.#epoch !== null) {
        const renewed = await this.#election.renew(this.#epoch, this.#leaseDurationMs);
        // Falha em renovar significa que outro processo ja assumiu (o epoch
        // no banco avancou) - a resposta correta e parar de agir como lider
        // IMEDIATAMENTE, nao tentar de novo torcendo para ainda ser valido.
        this.#setEpoch(renewed ? renewed.epoch : null);
      } else {
        const acquired = await this.#election.tryAcquire(this.#leaseDurationMs);
        // Chamado nos dois casos, nao so quando adquire: '#setEpoch' e quem
        // decide se ha algo a notificar (mudanca real OU primeira avaliacao).
        // Chama-lo so no caminho de sucesso deixava uma instancia que tenta e
        // FALHA repetidamente sem nunca notificar nada - o mesmo silencio que
        // a introducao de '#everNotified' tentou eliminar, so que por um
        // caminho de codigo diferente do que o teste original cobriu.
        this.#setEpoch(acquired ? acquired.epoch : null);
      }
    } catch {
      // Falha de conexao com o banco: trata como perda de lideranca por
      // seguranca. Um servico que nao consegue falar com o coordenador nao
      // tem como provar que ainda detem o lease.
      this.#setEpoch(null);
    }

    if (this.#stopped) return;
    this.#timer = setTimeout(() => void this.#tick(), this.isLeader() ? this.#renewIntervalMs : this.#retryIntervalMs);
    // unref: o timer do loop de lideranca nunca deve, por si so, ser o motivo
    // de um processo continuar vivo. Um ats-core real tem outras razoes
    // (conexao MQTT) para permanecer ativo; um teste ou script que esqueca de
    // chamar stop() nao deve travar por causa deste timer especificamente.
    this.#timer.unref?.();
  }
}
