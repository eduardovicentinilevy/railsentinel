/** Aritmetica complexa minima para a analise modal da malha circulante. */
export interface C { re: number; im: number }

export const c = (re: number, im = 0): C => ({ re, im });
export const add = (a: C, b: C): C => ({ re: a.re + b.re, im: a.im + b.im });
export const sub = (a: C, b: C): C => ({ re: a.re - b.re, im: a.im - b.im });
export const mul = (a: C, b: C): C => ({ re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re });
export const scale = (a: C, k: number): C => ({ re: a.re * k, im: a.im * k });
export const abs = (a: C): number => Math.hypot(a.re, a.im);

/** Raiz quadrada principal de um complexo. */
export function csqrt(z: C): C {
  const r = abs(z);
  if (r === 0) return c(0, 0);
  const re = Math.sqrt((r + z.re) / 2);
  const im = (z.im < 0 ? -1 : 1) * Math.sqrt(Math.max(0, (r - z.re) / 2));
  return c(re, im);
}

/** Autovalores de uma matriz complexa 2x2 pela equacao caracteristica. */
export function eigen2x2(a: C, b: C, cc: C, d: C): [C, C] {
  const tr = add(a, d);
  const det = sub(mul(a, d), mul(b, cc));
  const disc = csqrt(sub(mul(tr, tr), scale(det, 4)));
  return [scale(add(tr, disc), 0.5), scale(sub(tr, disc), 0.5)];
}

/** Raizes N-esimas da unidade: ω^k = e^{2πik/N}. */
export function rootsOfUnity(n: number): C[] {
  return Array.from({ length: n }, (_, k) => c(Math.cos((2 * Math.PI * k) / n), Math.sin((2 * Math.PI * k) / n)));
}
