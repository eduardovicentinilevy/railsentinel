import { useCcoState } from '../state/CcoProvider';
import { activeRestrictions, alarmSummary, edgeSummary, tspServiceRate } from '../state/selectors';

export function KpiRow() {
  const state = useCcoState();
  const alarms = alarmSummary(state);
  const restrictions = activeRestrictions(state).length;
  const held = state.trains.filter((t) => t.hold !== null).length;
  const tsp = tspServiceRate(state);
  const edge = edgeSummary();

  return (
    <section className="kpis" aria-label="Indicadores operacionais">
      <div className={`kpi${alarms.unacked > 0 ? ' alert' : ''}`}>
        <span className="kpi-label">Alarmes ativos</span>
        <div className="kpi-value-row">
          <span className="kpi-value">{alarms.total}</span>
          {alarms.unacked > 0 && <span className="kpi-unit">{alarms.unacked} sem reconhecimento</span>}
        </div>
        <span className="kpi-note">
          {alarms.critical} crítico · {alarms.major} maior
        </span>
      </div>
      <div className="kpi">
        <span className="kpi-label">Restrições de via</span>
        <div className="kpi-value-row">
          <span className="kpi-value">{restrictions}</span>
          <span className="kpi-unit">ativa{restrictions === 1 ? '' : 's'}</span>
        </div>
        <span className="kpi-note">
          {held === 0 ? 'nenhuma composição retida' : `${held} composição${held === 1 ? '' : 'ões'} retida${held === 1 ? '' : 's'}`}
        </span>
      </div>
      <div className="kpi">
        <span className="kpi-label">Atendimento TSP</span>
        <div className="kpi-value-row">
          <span className="kpi-value">{tsp === null ? '—' : Math.round(tsp * 100)}</span>
          <span className="kpi-unit">%</span>
        </div>
        <span className="kpi-delta pos">▲ 4pp turno anterior</span>
      </div>
      <div className="kpi">
        <span className="kpi-label">Erro RMS de headway</span>
        <div className="kpi-value-row">
          <span className="kpi-value">38</span>
          <span className="kpi-unit">s</span>
        </div>
        <span className="kpi-delta pos">▼ 45% vs. malha aberta</span>
      </div>
      <div className="kpi">
        <span className="kpi-label">Nós de borda</span>
        <div className="kpi-value-row">
          <span className="kpi-value">{edge.online}</span>
          <span className="kpi-unit">/ {edge.total} online</span>
        </div>
        <span className="kpi-note">{edge.offline.map((n) => n.id).join(', ') || 'cobertura completa'}</span>
      </div>
      <div className="kpi feature">
        <span className="kpi-label">Violações EN 50716</span>
        <div className="kpi-value-row">
          <span className="kpi-value good">0</span>
        </div>
        <span className="kpi-note">partição íntegra neste turno</span>
      </div>
    </section>
  );
}
