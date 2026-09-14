import type { TrainPositionData } from '@railsentinel/contracts';
import { allSections, getSection } from './topology.js';

/** Projecao do estado corrente da frota, alimentada pela telemetria normalizada. */
export interface TrainState extends TrainPositionData {
  updated_at: string;
  /** Ordem linear na linha - base para calcular headway entre pares. */
  linear_pos_m: number;
  stale: boolean;
}

const STALE_AFTER_MS = 15_000;

export class FleetRegistry {
  readonly #trains = new Map<string, TrainState>();

  upsert(pos: TrainPositionData, at: string): TrainState {
    const state: TrainState = {
      ...pos,
      updated_at: at,
      linear_pos_m: linearPosition(pos.section_id, pos.chainage_m ?? 0),
      stale: false,
    };
    this.#trains.set(pos.train_id, state);
    return state;
  }

  get(trainId: string): TrainState | undefined {
    return this.#trains.get(trainId);
  }

  /**
   * Composicoes presentes em um conjunto de secoes.
   * Marca como stale quem parou de reportar: um trem silencioso nao pode ser
   * tratado como ausente. Na duvida sobre posicao, o ATS assume ocupacao.
   */
  inSections(sectionIds: string[], now = Date.now()): TrainState[] {
    const out: TrainState[] = [];
    for (const t of this.#trains.values()) {
      if (!sectionIds.includes(t.section_id)) continue;
      out.push({ ...t, stale: now - Date.parse(t.updated_at) > STALE_AFTER_MS });
    }
    return out;
  }

  onLine(line: 'L1' | 'L2', now = Date.now()): TrainState[] {
    return [...this.#trains.values()]
      .filter((t) => getSection(t.section_id)?.line === line)
      .map((t) => ({ ...t, stale: now - Date.parse(t.updated_at) > STALE_AFTER_MS }))
      .sort((a, b) => a.linear_pos_m - b.linear_pos_m);
  }

  all(now = Date.now()): TrainState[] {
    return [...this.#trains.values()].map((t) => ({ ...t, stale: now - Date.parse(t.updated_at) > STALE_AFTER_MS }));
  }
}

/** Posicao linear acumulada ao longo da linha, para ordenar composicoes. */
function linearPosition(sectionId: string, chainage: number): number {
  const sections = allSections();
  const target = getSection(sectionId);
  if (!target) return chainage;
  let acc = 0;
  for (const s of sections) {
    if (s.line !== target.line) continue;
    if (s.id === sectionId) return acc + chainage;
    acc += s.length_m;
  }
  return acc + chainage;
}
