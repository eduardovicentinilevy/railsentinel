import { Crest } from '../Crest';
import { Icon, type IconName } from '../Icon';
import { OperatorBadge } from './OperatorBadge';
import { useClock } from '../../hooks/useClock';
import type { ThemeChoice } from '../../hooks/useTheme';
import { edgeSummary } from '../../state/selectors';
import { useUi } from '../../ui/UiProvider';
import { viewDef } from '../../ui/views';

const THEME: Record<ThemeChoice, { icon: IconName; label: string }> = {
  system: { icon: 'contrast', label: 'Tema do sistema' },
  light: { icon: 'sun', label: 'Tema diurno' },
  dark: { icon: 'moon', label: 'Tema noturno' },
};

export function Header() {
  const { view, setPaletteOpen, theme, cycleTheme } = useUi();
  const clock = useClock();
  const def = viewDef(view);
  const edge = edgeSummary();

  return (
    <header className="header">
      {/* faixa vermelho / dourado / verde do brasão de Santos — ornamento, nunca dado */}
      <div className="brand-bar" aria-hidden="true" />
      <div className="header-row">
        <div className="header-title">
          <span className="header-crest">
            <Crest size={28} />
          </span>
          <div>
            <span className="eyebrow">{def.group} · Linha 2</span>
            <h1>{def.title}</h1>
            <p className="header-desc">{def.description}</p>
          </div>
        </div>

        <div className="header-actions">
          <span className="pill demo">dados de demonstração</span>
          <span className="pill good hide-md">
            <span className="dot" />
            ats-core-4f1c líder · epoch 7
          </span>
          <span className={`pill ${edge.online === edge.total ? 'good' : 'neutral'} hide-md`}>
            <span className="dot" />
            {edge.online}/{edge.total} nós de borda
          </span>
          <button type="button" className="search-btn" onClick={() => setPaletteOpen(true)}>
            <Icon name="search" size={16} />
            <span className="search-label">Buscar</span>
            <span className="search-keys" aria-hidden="true">
              <kbd>Ctrl</kbd>
              <kbd>K</kbd>
            </span>
          </button>
          <button type="button" className="icon-btn" onClick={cycleTheme} aria-label={`${THEME[theme].label} — alternar`} title={`${THEME[theme].label} — alternar`}>
            <Icon name={THEME[theme].icon} />
          </button>
          <span className="clock mono" aria-label="Hora local">
            {clock}
          </span>
          <span className="header-operator">
            <OperatorBadge compact />
          </span>
        </div>
      </div>
    </header>
  );
}
