/**
 * Modelo de planta da frota - fisica compartilhada entre o simulador de bancada
 * e o banco de estabilidade.
 *
 * O compartilhamento e o ponto: se o banco de estabilidade usasse um modelo
 * proprio, ele provaria estabilidade de um sistema que nao e o que roda. Aqui a
 * mesma classe alimenta os dois, entao a margem medida no banco vale para o
 * simulador - e, na Fase 2, a mesma interface recebe a planta real.
 *
 * O modelo e deterministico e tem relogio virtual: nada de Date.now(). Isso
 * permite rodar 8 horas de operacao em milissegundos e repetir o experimento
 * bit a bit a partir de uma semente.
 */

export interface PlantSection {
  id: string;
  length_m: number;
  line_speed_kmh: number;
  hasStop: boolean;
}

export interface PlantTrain {
  id: string;
  sectionIdx: number;
  chainage_m: number;
  speed_kmh: number;
  schedule_dev_s: number;
  dwellRemaining_s: number;
  /** Dwell aconselhado para a proxima parada. */
  commandedDwell_s: number;
  commandedCoast_pct: number;
  /** Perturbacao pendente: segundos extras de embarque na proxima parada. */
  boardingSurge_s: number;
  /** Paradas cumpridas - usado para medir progresso. */
  stopsServed: number;
}

export interface PlantCommand {
  train_id: string;
  dwell_s: number;
  coast_pct: number;
}

export interface PlantConfig {
  sections: PlantSection[];
  dwellNominal_s: number;
  /** Piso local de acessibilidade - o CCO nao pode baixar disto. */
  dwellFloor_s: number;
  dwellCeiling_s: number;
  coastMax_pct: number;
}

/** Gerador congruente linear - reprodutivel a partir de uma semente. */
export class Rng {
  #s: number;
  constructor(seed = 1) { this.#s = seed >>> 0 || 1; }
  next(): number {
    this.#s = (Math.imul(this.#s, 1664525) + 1013904223) >>> 0;
    return this.#s / 0x100000000;
  }
  range(lo: number, hi: number): number { return lo + this.next() * (hi - lo); }
  pick<T>(arr: T[]): T { return arr[Math.floor(this.next() * arr.length)]!; }
}

export class TramPlant {
  readonly #cfg: PlantConfig;
  readonly #trains: PlantTrain[];
  readonly #totalLength_m: number;
  #clock_s = 0;

  constructor(cfg: PlantConfig, trains: PlantTrain[]) {
    this.#cfg = cfg;
    this.#trains = trains.map((t) => ({ ...t }));
    this.#totalLength_m = cfg.sections.reduce((a, s) => a + s.length_m, 0);
  }

  get clock_s(): number { return this.#clock_s; }
  get trains(): readonly PlantTrain[] { return this.#trains; }
  get loopLength_m(): number { return this.#totalLength_m; }

  /** Posicao linear acumulada, base para calcular espacamento. */
  linearPosition(t: PlantTrain): number {
    let acc = 0;
    for (let i = 0; i < t.sectionIdx; i++) acc += this.#cfg.sections[i]!.length_m;
    return acc + t.chainage_m;
  }

  /** Aplica comandos do controlador, com os limites LOCAIS da composicao. */
  applyCommands(cmds: PlantCommand[]): void {
    for (const c of cmds) {
      const t = this.#trains.find((x) => x.id === c.train_id);
      if (!t) continue;
      // O piso de acessibilidade e restricao de bordo. O CCO aconselha; o
      // computador de bordo nunca fecha porta antes do minimo.
      t.commandedDwell_s = Math.max(this.#cfg.dwellFloor_s, Math.min(this.#cfg.dwellCeiling_s, c.dwell_s));
      t.commandedCoast_pct = Math.max(0, Math.min(this.#cfg.coastMax_pct, c.coast_pct));
    }
  }

  /** Avanca a planta em dt segundos de tempo virtual. */
  step(dt: number): void {
    this.#clock_s += dt;
    for (const t of this.#trains) {
      if (t.dwellRemaining_s > 0) {
        t.dwellRemaining_s -= dt;
        t.speed_kmh = 0;
        if (t.dwellRemaining_s <= 0) {
          t.dwellRemaining_s = 0;
          t.commandedDwell_s = this.#cfg.dwellNominal_s; // comando vale uma parada
        }
        continue;
      }

      const sec = this.#cfg.sections[t.sectionIdx]!;
      t.speed_kmh = sec.line_speed_kmh * (1 - t.commandedCoast_pct / 100);
      t.chainage_m += (t.speed_kmh / 3.6) * dt;

      if (t.chainage_m >= sec.length_m) {
        t.chainage_m -= sec.length_m;
        t.sectionIdx = (t.sectionIdx + 1) % this.#cfg.sections.length;
        if (this.#cfg.sections[t.sectionIdx]!.hasStop) {
          const surge = t.boardingSurge_s;
          t.boardingSurge_s = 0;
          const applied = t.commandedDwell_s + surge;
          t.dwellRemaining_s = applied;
          t.schedule_dev_s += applied - this.#cfg.dwellNominal_s;
          t.commandedCoast_pct = 0;
          t.stopsServed += 1;
        }
      }
    }
  }

  /** Injeta um surto de embarque - a perturbacao que o regulador deve rejeitar. */
  injectSurge(trainId: string, seconds: number): void {
    const t = this.#trains.find((x) => x.id === trainId);
    if (t) t.boardingSurge_s = seconds;
  }

  /** Dispersao dos desvios de tabela - metrica primaria de bunching. */
  scheduleSpread_s(): number {
    const devs = this.#trains.map((t) => t.schedule_dev_s);
    return Math.max(...devs) - Math.min(...devs);
  }
}

/** Topologia da L2 no formato da planta. */
export const L2_PLANT_SECTIONS: PlantSection[] = [
  { id: 'L2-S11', length_m: 1200, line_speed_kmh: 30, hasStop: true },
  { id: 'L2-S12', length_m: 1500, line_speed_kmh: 30, hasStop: true },
  { id: 'L2-S13', length_m: 1400, line_speed_kmh: 25, hasStop: true },
  { id: 'L2-S14', length_m: 1100, line_speed_kmh: 25, hasStop: true },
  { id: 'L2-S15', length_m: 900, line_speed_kmh: 20, hasStop: true },
  { id: 'L2-S16', length_m: 1000, line_speed_kmh: 20, hasStop: true },
  { id: 'L2-S17', length_m: 1300, line_speed_kmh: 25, hasStop: true },
];

export const L2_PLANT_CONFIG: PlantConfig = {
  sections: L2_PLANT_SECTIONS,
  dwellNominal_s: 30,
  dwellFloor_s: 20,
  dwellCeiling_s: 90,
  coastMax_pct: 8,
};

export function makeTrain(id: string, sectionIdx: number, chainage_m: number): PlantTrain {
  return {
    id, sectionIdx, chainage_m, speed_kmh: 0, schedule_dev_s: 0,
    dwellRemaining_s: 0, commandedDwell_s: 30, commandedCoast_pct: 0,
    boardingSurge_s: 0, stopsServed: 0,
  };
}
