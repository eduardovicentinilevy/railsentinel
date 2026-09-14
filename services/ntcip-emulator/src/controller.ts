/**
 * Maquina de estados de um controlador semaforico atuado.
 *
 * Modelo anel-e-barreira simplificado, com as temporizacoes que a NTCIP 1202
 * expoe como objetos MIB. O que importa aqui nao e reproduzir um Econolite ou
 * um Brascontrol fielmente: e reproduzir as RESTRICOES que tornam o problema de
 * prioridade dificil, porque sao elas que determinam se o algoritmo de TSP
 * converge ou oscila.
 *
 * As tres restricoes que um TSP nao pode violar:
 *
 *   minGreen   - verde minimo por fase. Truncar abaixo disso deixa pedestres
 *                na faixa e veiculos presos na interseccao.
 *   yellow +   - amarelo e vermelho-geral sao intervalos de seguranca. Nao
 *   allRed       podem ser encurtados por nenhuma razao, prioridade inclusa.
 *   maxGreen   - teto de verde. Sem ele, extensoes sucessivas de prioridade
 *                esfomeariam indefinidamente o movimento transversal.
 *
 * Um emulador que ignorasse essas restricoes concederia toda prioridade pedida
 * e o TSP pareceria perfeito - exatamente o erro que faria a Fase 2 descobrir
 * em campo que o algoritmo nao funciona.
 */

export type PhaseColor = 'green' | 'yellow' | 'all_red';

export interface PhaseConfig {
  phase: number;
  /** Verde minimo, em segundos (NTCIP: phaseMinimumGreen). */
  minGreen: number;
  /** Verde maximo (NTCIP: phaseMaximumGreen). */
  maxGreen: number;
  /** Amarelo (NTCIP: phaseYellowChange). */
  yellow: number;
  /** Vermelho geral (NTCIP: phaseRedClear). */
  allRed: number;
  /** Verde nominal do plano de tempos. */
  splitGreen: number;
  label: string;
}

export interface ControllerState {
  activePhase: number;
  color: PhaseColor;
  /** Segundos decorridos no intervalo corrente. */
  elapsed: number;
  cycleCount: number;
  /** Extensao de verde concedida no intervalo corrente. */
  grantedExtension: number;
  /** Chamada de fase pendente. */
  pendingCall: number | null;
  /** Force-off pendente (truncamento de vermelho para a fase do VLT). */
  pendingForceOff: boolean;
}

export interface PriorityRequest {
  phase: number;
  /** 1 = phase_call, 2 = green_extension, 3 = red_truncation. */
  strategy: number;
  vehicleClass: number;
  requestId: string;
  maxExtension: number;
}

export type GrantOutcome =
  | { granted: true; strategy: number; effect: string; delaySeconds: number }
  | { granted: false; reason: string };

export class SignalController {
  readonly id: string;
  readonly #phases: PhaseConfig[];
  readonly #state: ControllerState;
  /** Segundos de verde cedidos ao VLT por ciclo - mede a fome do transversal. */
  readonly crossStreetDebt: number[] = [];
  #servedRequests = 0;
  #deniedRequests = 0;

  constructor(id: string, phases: PhaseConfig[]) {
    this.id = id;
    this.#phases = phases;
    this.#state = {
      activePhase: phases[0]!.phase, color: 'green', elapsed: 0, cycleCount: 0,
      grantedExtension: 0, pendingCall: null, pendingForceOff: false,
    };
  }

  get state(): Readonly<ControllerState> { return this.#state; }
  get phases(): readonly PhaseConfig[] { return this.#phases; }
  get counters() { return { served: this.#servedRequests, denied: this.#deniedRequests }; }

  phaseConfig(phase: number): PhaseConfig | undefined {
    return this.#phases.find((p) => p.phase === phase);
  }

  /** Avanca o relogio do controlador em dt segundos. */
  tick(dt = 1): void {
    const st = this.#state;
    const cfg = this.phaseConfig(st.activePhase)!;
    st.elapsed += dt;

    switch (st.color) {
      case 'green': {
        const limit = Math.min(cfg.splitGreen + st.grantedExtension, cfg.maxGreen);
        // Force-off so atua depois de cumprido o verde minimo - e a garantia
        // que impede o TSP de cortar a fase transversal na cara do pedestre.
        const forced = st.pendingForceOff && st.elapsed >= cfg.minGreen;
        if (st.elapsed >= limit || forced) {
          st.color = 'yellow';
          st.elapsed = 0;
          st.grantedExtension = 0;
          st.pendingForceOff = false;
        }
        break;
      }
      case 'yellow':
        if (st.elapsed >= cfg.yellow) { st.color = 'all_red'; st.elapsed = 0; }
        break;
      case 'all_red':
        if (st.elapsed >= cfg.allRed) {
          st.color = 'green';
          st.elapsed = 0;
          st.activePhase = this.#nextPhase();
          if (st.activePhase === this.#phases[0]!.phase) st.cycleCount += 1;
        }
        break;
    }
  }

  #nextPhase(): number {
    const st = this.#state;
    // Chamada de fase pendente ganha a proxima vez - e o efeito do phase_call.
    if (st.pendingCall !== null) {
      const called = st.pendingCall;
      st.pendingCall = null;
      if (this.phaseConfig(called)) return called;
    }
    const idx = this.#phases.findIndex((p) => p.phase === st.activePhase);
    return this.#phases[(idx + 1) % this.#phases.length]!.phase;
  }

  /**
   * Aplica um pedido de prioridade NTCIP 1202.
   * Retorna o desfecho real, nao o pedido - e essa diferenca que o CCO precisa
   * observar para regular, e que so existe porque o emulador respeita limites.
   */
  applyPriorityRequest(req: PriorityRequest): GrantOutcome {
    const st = this.#state;
    const target = this.phaseConfig(req.phase);
    if (!target) {
      this.#deniedRequests += 1;
      return { granted: false, reason: `fase ${req.phase} inexistente neste controlador` };
    }

    switch (req.strategy) {
      case 2: { // green_extension
        if (st.activePhase !== req.phase || st.color !== 'green') {
          this.#deniedRequests += 1;
          return { granted: false, reason: 'extensao pedida com a fase do VLT fora de verde' };
        }
        const cfg = this.phaseConfig(st.activePhase)!;
        const room = cfg.maxGreen - (cfg.splitGreen + st.grantedExtension);
        if (room <= 0) {
          this.#deniedRequests += 1;
          return { granted: false, reason: 'verde maximo ja atingido - transversal nao pode ser mais esfomeado' };
        }
        const granted = Math.min(req.maxExtension, room);
        st.grantedExtension += granted;
        this.#servedRequests += 1;
        this.crossStreetDebt.push(granted);
        return { granted: true, strategy: 2, effect: `verde estendido em ${granted}s`, delaySeconds: 0 };
      }

      case 3: { // red_truncation
        if (st.activePhase === req.phase) {
          this.#deniedRequests += 1;
          return { granted: false, reason: 'truncamento pedido com a fase do VLT ja ativa' };
        }
        const cfg = this.phaseConfig(st.activePhase)!;
        const remainingMin = Math.max(0, cfg.minGreen - st.elapsed);
        st.pendingForceOff = true;
        st.pendingCall = req.phase;
        this.#servedRequests += 1;
        const delay = remainingMin + cfg.yellow + cfg.allRed;
        this.crossStreetDebt.push(Math.max(0, cfg.splitGreen - Math.max(st.elapsed, cfg.minGreen)));
        return { granted: true, strategy: 3, effect: `force-off apos verde minimo; fase ${req.phase} chamada`, delaySeconds: delay };
      }

      default: { // 1 = phase_call
        if (st.activePhase === req.phase && st.color === 'green') {
          this.#deniedRequests += 1;
          return { granted: false, reason: 'fase do VLT ja esta em verde' };
        }
        st.pendingCall = req.phase;
        this.#servedRequests += 1;
        const cfg = this.phaseConfig(st.activePhase)!;
        const delay = Math.max(0, cfg.splitGreen - st.elapsed) + cfg.yellow + cfg.allRed;
        return { granted: true, strategy: 1, effect: `fase ${req.phase} chamada para o proximo intervalo`, delaySeconds: delay };
      }
    }
  }

  /** Tempo previsto ate a fase entrar em verde - realimentacao para o ATS. */
  secondsUntilGreen(phase: number): number {
    const st = this.#state;
    if (st.activePhase === phase && st.color === 'green') return 0;
    let total = 0;
    const cfg = this.phaseConfig(st.activePhase)!;
    if (st.color === 'green') total += Math.max(0, cfg.splitGreen + st.grantedExtension - st.elapsed) + cfg.yellow + cfg.allRed;
    else if (st.color === 'yellow') total += Math.max(0, cfg.yellow - st.elapsed) + cfg.allRed;
    else total += Math.max(0, cfg.allRed - st.elapsed);

    let idx = this.#phases.findIndex((p) => p.phase === st.activePhase);
    for (let i = 1; i <= this.#phases.length; i++) {
      const nxt = this.#phases[(idx + i) % this.#phases.length]!;
      if (nxt.phase === phase) break;
      total += nxt.splitGreen + nxt.yellow + nxt.allRed;
    }
    return Math.round(total);
  }
}
