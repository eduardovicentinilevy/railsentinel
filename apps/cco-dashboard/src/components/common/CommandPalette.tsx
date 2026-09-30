import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Icon, type IconName } from '../Icon';
import { sectionAt } from '../../domain/line';
import { stamp, useCcoDispatch, useCcoState } from '../../state/CcoProvider';
import { activeRestrictions, formatDev } from '../../state/selectors';
import type { SimRate } from '../../state/types';
import { useUi } from '../../ui/UiProvider';
import { VIEWS } from '../../ui/views';
import { normalize } from '../../ui/text';

interface PaletteItem {
  id: string;
  group: 'Seções' | 'Composições' | 'Ações';
  label: string;
  hint?: string;
  icon: IconName;
  run: () => void;
}

function usePaletteItems(): PaletteItem[] {
  const state = useCcoState();
  const dispatch = useCcoDispatch();
  const { go, openRelease, cycleTheme } = useUi();

  return useMemo(() => {
    const items: PaletteItem[] = VIEWS.map((v, i) => ({
      id: `view-${v.key}`,
      group: 'Seções',
      label: v.label,
      hint: String(i + 1),
      icon: v.icon,
      run: () => go(v.key),
    }));

    for (const t of state.trains) {
      items.push({
        id: `train-${t.id}`,
        group: 'Composições',
        label: `${t.id} — ${sectionAt(t.t).id}`,
        hint: formatDev(t.dev),
        icon: 'line',
        run: () => {
          dispatch({ type: 'SELECT_TRAIN', trainId: t.id });
          go('linha');
        },
      });
    }

    if (state.operator) {
      for (const a of state.alarms.filter((x) => x.ack === null)) {
        items.push({
          id: `ack-${a.id}`,
          group: 'Ações',
          label: `Reconhecer alarme ${a.id}`,
          hint: a.sev === 'critical' ? 'crítico' : 'maior',
          icon: 'check',
          run: () => dispatch({ type: 'ALARM_ACK', alarmId: a.id, at: stamp() }),
        });
      }
      for (const r of activeRestrictions(state)) {
        items.push({
          id: `release-${r.id}`,
          group: 'Ações',
          label: `Liberar ${r.id} (${r.sectionId})…`,
          icon: 'shield',
          run: () => openRelease(r.id),
        });
      }
    }

    const rates: Array<[SimRate, string]> = [
      [0, 'Simulação: pausar'],
      [1, 'Simulação: tempo real (1×)'],
      [10, 'Simulação: acelerar (10×)'],
    ];
    for (const [rate, label] of rates) {
      if (rate !== state.simRate) {
        items.push({ id: `sim-${rate}`, group: 'Ações', label, icon: 'clock', run: () => dispatch({ type: 'SET_SIM_RATE', rate }) });
      }
    }
    items.push({ id: 'theme', group: 'Ações', label: 'Alternar tema do posto', icon: 'contrast', run: cycleTheme });
    items.push({ id: 'handover', group: 'Ações', label: 'Preparar passagem de turno', icon: 'handover', run: () => go('passagem') });
    return items;
  }, [state, dispatch, go, openRelease, cycleTheme]);
}

export function CommandPalette() {
  const { paletteOpen, setPaletteOpen } = useUi();
  if (!paletteOpen) return null;
  return <PaletteDialog onClose={() => setPaletteOpen(false)} />;
}

function PaletteDialog({ onClose }: { onClose: () => void }) {
  const items = usePaletteItems();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const results = useMemo(() => {
    const q = normalize(query.trim());
    return q ? items.filter((i) => normalize(`${i.label} ${i.group}`).includes(q)) : items;
  }, [items, query]);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    return () => opener?.focus();
  }, []);

  useEffect(() => setActive(0), [query]);

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  function run(item: PaletteItem | undefined) {
    if (!item) return;
    onClose();
    item.run();
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(results.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      run(results[active]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  }

  let lastGroup = '';
  return (
    <div className="overlay top" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Busca rápida">
        <div className="palette-search">
          <Icon name="search" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKey}
            placeholder="Ir para seção, composição ou ação…"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={results[active] ? `pal-${results[active].id}` : undefined}
            aria-label="Buscar seção, composição ou ação"
          />
          <kbd>Esc</kbd>
        </div>
        <ul className="palette-list" id="palette-list" role="listbox" ref={listRef}>
          {results.length === 0 && <li className="palette-empty">Nada encontrado para “{query}”.</li>}
          {results.map((item, i) => {
            const header = item.group !== lastGroup ? item.group : null;
            lastGroup = item.group;
            return (
              <li key={item.id} role="presentation">
                {header && <div className="palette-group">{header}</div>}
                <div
                  id={`pal-${item.id}`}
                  role="option"
                  aria-selected={i === active}
                  className="palette-item"
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    run(item);
                  }}
                >
                  <Icon name={item.icon} size={16} />
                  <span className="palette-label">{item.label}</span>
                  {item.hint && <span className="palette-hint mono">{item.hint}</span>}
                </div>
              </li>
            );
          })}
        </ul>
        <div className="palette-foot">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> navegar
          </span>
          <span>
            <kbd>↵</kbd> executar
          </span>
          <span>
            <kbd>1</kbd>–<kbd>7</kbd> seções, fora da busca
          </span>
        </div>
      </div>
    </div>
  );
}
