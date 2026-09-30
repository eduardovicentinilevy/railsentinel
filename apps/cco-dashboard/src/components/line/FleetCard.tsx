import { Card } from '../Card';
import { nextStop, sectionAt } from '../../domain/line';
import { useCcoDispatch, useCcoState } from '../../state/CcoProvider';
import { formatDev, latestTsp } from '../../state/selectors';
import type { TrainState } from '../../state/types';

export function fleetStatus(t: TrainState): { dot: 'ok' | 'warn' | 'crit'; text: string; restrictionId?: string } {
  if (!t.hold) return { dot: 'ok', text: 'em marcha' };
  if (t.hold.kind === 'restriction') return { dot: 'crit', text: 'retido', restrictionId: t.hold.restrictionId };
  return { dot: 'warn', text: `aguarda ${t.hold.trainId}` };
}

export function FleetCard() {
  const state = useCcoState();
  const dispatch = useCcoDispatch();

  return (
    <Card title="Frota em circulação" meta="clique para abrir o posto da composição" flush>
      <div className="table-scroll">
        <table className="fleet">
          <thead>
            <tr>
              <th scope="col">Composição</th>
              <th scope="col">Seção</th>
              <th scope="col">Próxima parada</th>
              <th scope="col" className="r">
                Desvio
              </th>
              <th scope="col">Lotação</th>
              <th scope="col">Estado</th>
            </tr>
          </thead>
          <tbody>
            {state.trains.map((t) => {
              const selected = state.selectedTrain === t.id;
              const tsp = latestTsp(state, t.id);
              const status = fleetStatus(t);
              return (
                <tr
                  key={t.id}
                  className={selected ? 'selected' : undefined}
                  aria-selected={selected}
                  onClick={() => dispatch({ type: 'SELECT_TRAIN', trainId: selected ? null : t.id })}
                >
                  <td>
                    <button
                      type="button"
                      className="row-link"
                      aria-pressed={selected}
                      onClick={(e) => {
                        e.stopPropagation();
                        dispatch({ type: 'SELECT_TRAIN', trainId: selected ? null : t.id });
                      }}
                    >
                      <span className="legend-swatch" style={{ background: `var(${t.colorVar})` }} />
                      <span className="mono strong">{t.id}</span>
                    </button>
                  </td>
                  <td className="mono">{sectionAt(t.t).id}</td>
                  <td>{nextStop(t.t).name}</td>
                  <td className={`mono r ${t.dev > 0.5 ? 'late' : t.dev < -0.5 ? 'early' : ''}`}>{formatDev(t.dev)}</td>
                  <td>{t.occ}</td>
                  <td className="wrap">
                    <div className="state-cell">
                      <span className="nowrap">
                        <span className={`status-dot inline ${status.dot}`} />
                        {status.text}
                      </span>
                      {status.restrictionId && <span className="chip held mono">{status.restrictionId}</span>}
                      {tsp?.action === 'grant' && <span className="chip mono">TSP {tsp.strategy}</span>}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
