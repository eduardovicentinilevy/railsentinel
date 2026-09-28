import { useEffect, useState } from 'react';

export type ThemeChoice = 'system' | 'light' | 'dark';

const KEY = 'railsentinel.cco.theme';
const ORDER: ThemeChoice[] = ['system', 'light', 'dark'];

function readStored(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

/** Tema diurno/noturno por posto: preferência local do navegador, nunca estado operacional. */
export function useTheme(): [ThemeChoice, () => void] {
  const [theme, setTheme] = useState<ThemeChoice>(readStored);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') delete root.dataset.theme;
    else root.dataset.theme = theme;
    try {
      if (theme === 'system') localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, theme);
    } catch {
      // armazenamento bloqueado: o tema vale só para esta sessão
    }
  }, [theme]);

  const cycle = () => setTheme((t) => ORDER[(ORDER.indexOf(t) + 1) % ORDER.length]);
  return [theme, cycle];
}
