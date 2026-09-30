import { Crest } from '../Crest';
import { Icon } from '../Icon';
import { OperatorBadge } from './OperatorBadge';
import { useCcoState } from '../../state/CcoProvider';
import { activeRestrictions, alarmSummary, edgeSummary } from '../../state/selectors';
import { useUi } from '../../ui/UiProvider';
import { VIEWS, type ViewDef, type ViewKey } from '../../ui/views';

const GROUPS: ViewDef['group'][] = ['Operação', 'Campo', 'Turno'];

function useBadges(): Partial<Record<ViewKey, { count: number; tone: 'crit' | 'warn' }>> {
  const state = useCcoState();
  const pendingOps = alarmSummary(state).unacked + activeRestrictions(state).length;
  const held = state.trains.filter((t) => t.hold !== null).length;
  const offline = edgeSummary().offline.length;
  return {
    ...(pendingOps > 0 && { alarmes: { count: pendingOps, tone: 'crit' as const } }),
    ...(held > 0 && { linha: { count: held, tone: 'crit' as const } }),
    ...(offline > 0 && { borda: { count: offline, tone: 'warn' as const } }),
  };
}

export function Sidebar({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const { view } = useUi();
  const badges = useBadges();

  return (
    <nav className="sidebar" aria-label="Seções do CCO">
      <div className="sidebar-inner">
        <a className="sidebar-brand" href="#geral" title="RailSentinel — CCO VLT Baixada Santista">
          <Crest size={34} />
          <span className="sidebar-wordmark">
            <span className="brand-mark">
              RAIL<span>SENTINEL</span>
            </span>
            <span className="brand-sub">CCO · VLT Baixada Santista</span>
          </span>
        </a>

        <div className="nav-groups">
          {GROUPS.map((group) => (
            <div className="nav-group" key={group}>
              <span className="nav-group-label">{group}</span>
              {VIEWS.filter((v) => v.group === group).map((v) => {
                const badge = badges[v.key];
                const n = VIEWS.indexOf(v) + 1;
                return (
                  <a
                    key={v.key}
                    href={`#${v.key}`}
                    className="nav-item"
                    aria-current={view === v.key ? 'page' : undefined}
                    title={`${v.label} — atalho ${n}`}
                  >
                    <Icon name={v.icon} />
                    <span className="nav-label">{v.label}</span>
                    <span className="nav-short">{v.short}</span>
                    {badge && (
                      <span className={`nav-badge ${badge.tone}`} aria-label={`${badge.count} pendente${badge.count === 1 ? '' : 's'}`}>
                        {badge.count}
                      </span>
                    )}
                  </a>
                );
              })}
            </div>
          ))}
        </div>

        <div className="sidebar-foot">
          <OperatorBadge />
          <button type="button" className="nav-collapse" onClick={onToggle} aria-pressed={collapsed} aria-label={collapsed ? 'Expandir menu' : 'Recolher menu'}>
            <Icon name={collapsed ? 'chevronRight' : 'chevronLeft'} size={16} />
            <span className="nav-label">Recolher menu</span>
          </button>
        </div>
      </div>
    </nav>
  );
}
