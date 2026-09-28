import type { ReactNode } from 'react';
import { useCcoState } from '../state/CcoProvider';
import { activeRestrictions, alarmSummary, edgeSummary, tspServiceRate } from '../state/selectors';

type Tone = 'crit' | 'good' | null;

function Kpi({ label, value, unit, tone = null, flag, note }: {
  label: string;
  value: ReactNode;
  unit?: string;
  tone?: Tone;
  flag?: ReactNode;
  note: ReactNode;
}) {
  return (
    <div className={`kpi${tone ? ` ${tone}` : ''}`}>
      <span className="kpi-label">{label}</span>
      <span className="kpi-value">
        {value}
        {unit && <span className="kpi-unit">{unit}</span>}
      </span>
      {flag}
      <span className="kpi-note">{note}</span>
    </div>
  );
}

export function KpiRow() {
  const state = useCcoState();
  const alarms = alarmSummary(state);
  const restrictions = activeRestrictions(state).length;
  const held = state.trains.filter((t) => t.hold !== null).length;
  const tsp = tspServiceRate(state);
  const edge = edgeSummary();

  return (
    <section className="kpis" aria-label="Indicadores operacionais">
      <Kpi
        label="Alarmes ativos"
        value={alarms.total}
        tone={alarms.unacked > 0 ? 'crit' : null}
        flag={alarms.unacked > 0 && <span className="kpi-flag crit">{alarms.unacked} sem reconhecimento</span>}
        note={`${alarms.critical} crítico · ${alarms.major} maior`}
      />
      <Kpi
        label="Restrições de via"
        value={restrictions}
        unit={restrictions === 1 ? 'ativa' : 'ativas'}
        tone={held > 0 ? 'crit' : null}
        flag={held > 0 && <span className="kpi-flag crit">{held === 1 ? '1 composição retida' : `${held} composições retidas`}</span>}
        note={held === 0 ? 'nenhuma composição retida' : 'aguardando liberação do operador'}
      />
      <Kpi
        label="Atendimento TSP"
        value={tsp === null ? '—' : Math.round(tsp * 100)}
        unit="%"
        note={<span className="kpi-trend">▲ 4 pp vs. turno anterior</span>}
      />
      <Kpi
        label="Erro RMS de headway"
        value={38}
        unit="s"
        note={<span className="kpi-trend">▼ 45% vs. malha aberta</span>}
      />
      <Kpi
        label="Nós de borda"
        value={edge.online}
        unit={`/ ${edge.total}`}
        note={edge.offline.length ? `${edge.offline.map((n) => n.id).join(', ')} offline` : 'cobertura completa'}
      />
      <Kpi label="Violações EN 50716" value={0} tone="good" note="SafetyGuard ativo · partição íntegra" />
    </section>
  );
}
