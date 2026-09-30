import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTheme, type ThemeChoice } from '../hooks/useTheme';
import { useCcoState } from '../state/CcoProvider';
import type { LogEntry } from '../state/types';
import { isViewKey, type ViewKey } from './views';

export type ToastTone = 'good' | 'info' | 'warn';

export interface Toast {
  id: number;
  tone: ToastTone;
  text: string;
  operator: string | null;
}

interface Ui {
  view: ViewKey;
  go: (view: ViewKey) => void;
  toasts: Toast[];
  dismissToast: (id: number) => void;
  paletteOpen: boolean;
  setPaletteOpen: (open: boolean) => void;
  /** restrição cuja liberação está sendo confirmada no diálogo */
  releaseTarget: string | null;
  openRelease: (restrictionId: string) => void;
  closeRelease: () => void;
  theme: ThemeChoice;
  cycleTheme: () => void;
}

const UiContext = createContext<Ui | null>(null);
const TOAST_TTL_MS = 5000;
const MAX_TOASTS = 4;

function readHash(): ViewKey {
  const h = window.location.hash.replace(/^#/, '');
  return isViewKey(h) ? h : 'geral';
}

function toneFor(e: LogEntry): ToastTone {
  if (e.kind === 'ack' || e.kind === 'clear') return 'good';
  if (e.kind === 'system' && e.text.includes('parado')) return 'warn';
  return 'info';
}

export function UiProvider({ children }: { children: ReactNode }) {
  const { log, nextSeq } = useCcoState();
  const [view, setView] = useState<ViewKey>(readHash);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [releaseTarget, setReleaseTarget] = useState<string | null>(null);
  const [theme, cycleTheme] = useTheme();

  useEffect(() => {
    const onHash = () => setView(readHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [view]);

  const go = useCallback((next: ViewKey) => {
    if (window.location.hash === `#${next}`) setView(next);
    else window.location.hash = next;
  }, []);

  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const dismissToast = useCallback((id: number) => {
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach((t) => clearTimeout(t));
  }, []);

  // Toasts espelham o registro do turno: cada comando aceito pelo reducer vira
  // exatamente um aviso — um comando recusado não gera nem aviso nem registro.
  const lastSeen = useRef(nextSeq - 1);
  useEffect(() => {
    const fresh = log.filter((e) => e.seq > lastSeen.current).reverse();
    if (fresh.length === 0) return;
    lastSeen.current = Math.max(...fresh.map((e) => e.seq));
    setToasts((prev) =>
      [...prev, ...fresh.map((e) => ({ id: e.seq, tone: toneFor(e), text: e.text, operator: e.kind === 'session' ? null : e.operator }))].slice(
        -MAX_TOASTS,
      ),
    );
    for (const e of fresh) timers.current.set(e.seq, setTimeout(() => dismissToast(e.seq), TOAST_TTL_MS));
  }, [log, dismissToast]);

  const value = useMemo<Ui>(
    () => ({
      view,
      go,
      toasts,
      dismissToast,
      paletteOpen,
      setPaletteOpen,
      releaseTarget,
      openRelease: setReleaseTarget,
      closeRelease: () => setReleaseTarget(null),
      theme,
      cycleTheme,
    }),
    [view, go, toasts, dismissToast, paletteOpen, releaseTarget, theme, cycleTheme],
  );

  return <UiContext.Provider value={value}>{children}</UiContext.Provider>;
}

export function useUi(): Ui {
  const ui = useContext(UiContext);
  if (!ui) throw new Error('useUi fora do <UiProvider>');
  return ui;
}
