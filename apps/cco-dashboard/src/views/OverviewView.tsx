import { Card } from '../components/Card';
import { Crest } from '../components/Crest';
import { EventLog } from '../components/EventLog';
import { Icon } from '../components/Icon';
import { KpiRow } from '../components/KpiRow';
import { LineCard } from '../components/line/LineDiagram';
import { PendingList } from '../components/PendingList';
import { STOPS } from '../data/mock';
import { useCcoState } from '../state/CcoProvider';
import { activeRestrictions, alarmSummary, edgeSummary, lineStatus, pendingItems } from '../state/selectors';
import { useUi } from '../ui/UiProvider';

const LAMP_LABEL = { crit: 'Ação necessária', warn: 'Atenção', ok: 'Normal' } as const;

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function situation(state: ReturnType<typeof useCcoState>): string {
  const a = alarmSummary(state);
  const parts: string[] = [];
  if (a.unacked > 0) parts.push(plural(a.unacked, 'alarme sem reconhecimento', 'alarmes sem reconhecimento'));
  const r = activeRestrictions(state).length;
  if (r > 0) parts.push(plural(r, 'restrição de via ativa', 'restrições de via ativas'));
  const held = state.trains.filter((t) => t.hold?.kind === 'restriction').length;
  if (held > 0) parts.push(plural(held, 'composição retida', 'composições retidas'));
  const off = edgeSummary().offline.length;
  if (off > 0) parts.push(plural(off, 'nó de borda offline', 'nós de borda offline'));
  if (parts.length === 0) return 'Operação normal: nada pendente no posto.';
  const last = parts.pop();
  return `${parts.length ? `${parts.join(', ')} e ${last}` : last}.`;
}

function LinkButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" className="link-btn" onClick={onClick}>
      {label}
      <Icon name="arrowRight" size={14} />
    </button>
  );
}

export function OverviewView() {
  const state = useCcoState();
  const { go } = useUi();
  const status = lineStatus(state);
  const pending = pendingItems(state).length;

  return (
    <div className="view">
      <section className={`hero ${status}`} aria-label="Situação da linha">
        <div className="hero-text">
          <span className="eyebrow">Situação da linha · agora</span>
          <h2>Linha 2 — Loop Centro Histórico</h2>
          <p className="hero-sentence">{situation(state)}</p>
          <p className="hero-facts">
            <span>{state.trains.length} composições</span>
            <span>{STOPS.length} paradas</span>
            <span>headway alvo 474 s</span>
            <span>{state.operator ? `operador ${state.operator}` : 'posto sem operador'}</span>
          </p>
        </div>
        <div className="hero-lamp" role="status">
          <span className="lamp" aria-hidden="true" />
          <span className="lamp-label">{LAMP_LABEL[status]}</span>
        </div>
        <Crest size={220} className="hero-watermark" />
      </section>

      <KpiRow />

      <div className="split">
        <Card title="Requer ação" meta={pending === 0 ? 'nada pendente' : `${pending} pendência${pending === 1 ? '' : 's'}`} flush>
          <PendingList />
        </Card>
        <EventLog limit={6} actions={<LinkButton label="Registro completo" onClick={() => go('registro')} />} />
      </div>

      <LineCard title="Linha agora" actions={<LinkButton label="Abrir Linha 2" onClick={() => go('linha')} />} />
    </div>
  );
}
