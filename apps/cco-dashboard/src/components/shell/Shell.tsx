import { useEffect, useState } from 'react';
import { Header } from './Header';
import { Sidebar } from './Sidebar';
import { CommandPalette } from '../common/CommandPalette';
import { Toasts } from '../common/Toasts';
import { Footer } from '../Footer';
import { ReleaseDialog } from '../ReleaseDialog';
import { AlarmsView } from '../../views/AlarmsView';
import { EdgeView } from '../../views/EdgeView';
import { HandoverView } from '../../views/HandoverView';
import { LineView } from '../../views/LineView';
import { LogView } from '../../views/LogView';
import { OverviewView } from '../../views/OverviewView';
import { TspView } from '../../views/TspView';
import { useUi } from '../../ui/UiProvider';
import { VIEWS, type ViewKey } from '../../ui/views';

const VIEW_COMPONENT: Record<ViewKey, () => JSX.Element> = {
  geral: OverviewView,
  linha: LineView,
  alarmes: AlarmsView,
  tsp: TspView,
  borda: EdgeView,
  registro: LogView,
  passagem: HandoverView,
};

const NAV_KEY = 'railsentinel.cco.nav';

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(NAV_KEY) === 'rail';
  } catch {
    return false;
  }
}

export function Shell() {
  const { view, go, paletteOpen, setPaletteOpen, releaseTarget } = useUi();
  const [collapsed, setCollapsed] = useState(readCollapsed);

  useEffect(() => {
    try {
      localStorage.setItem(NAV_KEY, collapsed ? 'rail' : 'full');
    } catch {
      // preferência só desta sessão
    }
  }, [collapsed]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen(!paletteOpen);
        return;
      }
      if (paletteOpen || releaseTarget || e.ctrlKey || e.metaKey || e.altKey) return;
      if ((e.target as HTMLElement).closest('input, textarea, select, [contenteditable="true"]')) return;
      const n = Number.parseInt(e.key, 10);
      if (n >= 1 && n <= VIEWS.length) go(VIEWS[n - 1].key);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go, paletteOpen, setPaletteOpen, releaseTarget]);

  const View = VIEW_COMPONENT[view];

  return (
    <div className="app" data-nav={collapsed ? 'rail' : 'full'}>
      <a className="skip-link" href="#conteudo">
        Pular para o conteúdo
      </a>
      <Sidebar collapsed={collapsed} onToggle={() => setCollapsed((c) => !c)} />
      <div className="app-main">
        <Header />
        <main className="page" id="conteudo" tabIndex={-1}>
          <View key={view} />
          <Footer />
        </main>
      </div>
      <CommandPalette />
      <ReleaseDialog />
      <Toasts />
    </div>
  );
}
