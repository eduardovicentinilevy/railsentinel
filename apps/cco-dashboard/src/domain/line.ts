import { SECTIONS, STOPS } from '../data/mock.ts';
import type { Section, Stop } from '../data/mock.ts';

/** Normaliza uma posição do loop para [0, 1). */
export function wrap(t: number): number {
  return ((t % 1) + 1) % 1;
}

/** Distância percorrida de `from` até `to` no sentido de circulação, em [0, 1). */
export function forward(from: number, to: number): number {
  return wrap(to - from);
}

export function isInside(t: number, range: readonly [number, number]): boolean {
  return forward(range[0], t) <= forward(range[0], range[1]);
}

export function sectionAt(t: number): Section {
  const found = SECTIONS.find((s) => isInside(t, s.range));
  return found ?? SECTIONS[SECTIONS.length - 1];
}

export function nextStop(t: number): Stop {
  let best = STOPS[0];
  let bestDist = Infinity;
  for (const s of STOPS) {
    const d = forward(t, s.t);
    if (d > 0 && d < bestDist) {
      best = s;
      bestDist = d;
    }
  }
  return best;
}
