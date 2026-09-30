import { Icon } from './Icon';
import { SECTIONS } from '../data/mock';
import { stamp, useCcoDispatch, useCcoState } from '../state/CcoProvider';
import { pendingItems, type PendingItem } from '../state/selectors';
import { useUi } from '../ui/UiProvider';

const SEV_LABEL = { critical: 'CRÍTICO', major: 'MAIOR', warning: 'AVISO' } as const;

function keyOf(item: PendingItem): string {
  if (item.kind === 'alarm') return `a-${item.alarm.id}`;
  if (item.kind === 'restriction') return `r-${item.restriction.id}`;
  return `e-${item.node.id}`;
}

/** Pendências em ordem de ação, cada uma com o comando que a resolve. */
export function PendingList({ actionable = true }: { actionable?: boolean }) {
  const state = useCcoState();
  const dispatch = useCcoDispatch();
  const { go, openRelease } = useUi();
  const items = pendingItems(state);
  const canOperate = state.operator !== null;
  const blocked = canOperate ? undefined : 'Identifique-se no posto para operar';

  if (items.length === 0) {
    return (
      <div className="all-clear">
        <span className="all-clear-icon">
          <Icon name="check" size={20} />
        </span>
        <div>
          <strong>Nada pendente.</strong>
          <p>Alarmes reconhecidos, nenhuma restrição ativa e cobertura de borda completa.</p>
        </div>
      </div>
    );
  }

  return (
    <ul className="pending-list">
      {items.map((item) => {
        if (item.kind === 'alarm') {
          const a = item.alarm;
          return (
            <li key={keyOf(item)} className={`pending ${a.sev}`}>
              <span className={`sev-tag ${a.sev}`}>{SEV_LABEL[a.sev]}</span>
              <div className="pending-text">
                <span className="pending-title">{a.title}</span>
                <span className="pending-sub mono">
                  {a.id} · sem reconhecimento desde {a.raisedAt}
                </span>
              </div>
              {actionable && (
                <button type="button" className="primary small" disabled={!canOperate} title={blocked} onClick={() => dispatch({ type: 'ALARM_ACK', alarmId: a.id, at: stamp() })}>
                  Reconhecer
                </button>
              )}
            </li>
          );
        }
        if (item.kind === 'restriction') {
          const r = item.restriction;
          const section = SECTIONS.find((s) => s.id === r.sectionId);
          return (
            <li key={keyOf(item)} className="pending critical">
              <span className="sev-tag restriction">RESTRIÇÃO</span>
              <div className="pending-text">
                <span className="pending-title">
                  {r.kind.toLowerCase()} em {r.sectionId}
                  {section && ` · ${section.from}–${section.to}`}
                </span>
                <span className="pending-sub mono">
                  {r.id} · ativa desde {r.createdAt}
                  {item.held.length > 0 && ` · retidas: ${item.held.map((t) => t.id).join(', ')}`}
                </span>
              </div>
              {actionable && (
                <button type="button" className="primary small" disabled={!canOperate} title={blocked} onClick={() => openRelease(r.id)}>
                  Liberar…
                </button>
              )}
            </li>
          );
        }
        return (
          <li key={keyOf(item)} className="pending major">
            <span className="sev-tag edge">BORDA</span>
            <div className="pending-text">
              <span className="pending-title">
                <span className="mono">{item.node.id}</span> offline
              </span>
              <span className="pending-sub">sem detecção automática de invasão neste trecho</span>
            </div>
            {actionable && (
              <button type="button" className="small" onClick={() => go('borda')}>
                Ver nós
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
