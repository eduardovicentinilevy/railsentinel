import { nextStop } from './line.ts';

/** Abaixo deste desvio a composição está "em tabela" e não recebe aviso. */
export const HOLD_THRESHOLD_S = 15;

export type RegulationAdvice =
  | { kind: 'hold'; seconds: number; stop: string }
  | { kind: 'none'; reason: string };

/**
 * Aviso de regulação de headway ao condutor (advisory, Integridade Básica):
 * composição adiantada segura na próxima parada; atrasada nunca é retida —
 * quem a ajuda é a prioridade semafórica.
 */
export function regulationAdvice(train: { t: number; dev: number }): RegulationAdvice {
  if (train.dev <= -HOLD_THRESHOLD_S) {
    return { kind: 'hold', seconds: Math.round(-train.dev), stop: nextStop(train.t).name };
  }
  if (train.dev >= HOLD_THRESHOLD_S) {
    return { kind: 'none', reason: 'atrasada — não se retém; o TSP já prioriza a composição' };
  }
  return { kind: 'none', reason: `dentro da tabela (±${HOLD_THRESHOLD_S} s)` };
}
