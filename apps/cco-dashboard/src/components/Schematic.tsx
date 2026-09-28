import type { KeyboardEvent } from 'react';
import { Card } from './Card';
import { STOPS } from '../data/mock';
import { stamp, useCcoDispatch, useCcoState } from '../state/CcoProvider';
import { activeRestrictions, formatDev, holdLabel } from '../state/selectors';
import { nextStop, sectionAt } from '../domain/line';
import type { SimRate, TrainState } from '../state/types';

const W = 760;
const PAD = 44;
const TRACK_Y = 96;
const TRACK_W = W - PAD * 2;
const VIEW_Y = 40;
const VIEW_H = 108;

function x(t: number): number {
  return PAD + t * TRACK_W;
}

const RATES: Array<{ rate: SimRate; label: string }> = [
  { rate: 0, label: 'Pausa' },
  { rate: 1, label: '1×' },
  { rate: 10, label: '10×' },
];

function SimControls() {
  const { simRate } = useCcoState();
  const dispatch = useCcoDispatch();
  return (
    <div className="segmented" role="group" aria-label="Velocidade da simulação">
      {RATES.map(({ rate, label }) => (
        <button
          type="button"
          key={rate}
          aria-pressed={simRate === rate}
          className={simRate === rate ? 'on' : undefined}
          onClick={() => dispatch({ type: 'SET_SIM_RATE', rate })}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function LineSvg() {
  const state = useCcoState();
  const dispatch = useCcoDispatch();
  const restrictions = activeRestrictions(state);

  const select = (id: string) => dispatch({ type: 'SELECT_TRAIN', trainId: state.selectedTrain === id ? null : id });
  const onKey = (e: KeyboardEvent, id: string) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      select(id);
    }
  };

  return (
    <div className="schematic-scroll">
      <svg viewBox={`0 ${VIEW_Y} ${W} ${VIEW_H}`} role="group" aria-label="Esquema da Linha 2 com posição das composições">
        <path className="track-line" d={`M${x(0)} ${TRACK_Y} L${x(1)} ${TRACK_Y}`} />
        {restrictions.map((r) => {
          const [a, b] = r.range;
          return (
            <g key={r.id}>
              <path className="restr-marker" d={`M${x(a)} ${TRACK_Y} L${x(b)} ${TRACK_Y}`} />
              <text className="restr-label" x={(x(a) + x(b)) / 2} y={TRACK_Y + 16} textAnchor="middle">
                {r.id}
              </text>
            </g>
          );
        })}

        {STOPS.map((s) => (
          <g key={s.id}>
            <circle className="stop-dot" cx={x(s.t)} cy={TRACK_Y} r={4} />
            <text className="stop-label" x={x(s.t)} y={TRACK_Y + 32} textAnchor="middle">
              {s.name}
            </text>
          </g>
        ))}

        {state.trains.map((t) => {
          const tx = x(t.t);
          const ty = TRACK_Y - 26;
          const selected = state.selectedTrain === t.id;
          const devColor = t.dev > 0.5 ? 'var(--d-late)' : t.dev < -0.5 ? 'var(--d-early)' : 'var(--muted)';
          const dimmed = state.selectedTrain !== null && !selected;
          return (
            <g
              key={t.id}
              className={`train-marker${selected ? ' selected' : ''}${dimmed ? ' dimmed' : ''}`}
              role="button"
              tabIndex={0}
              aria-pressed={selected}
              aria-label={`${t.id}, desvio ${formatDev(t.dev)}, ${holdLabel(t.hold)}`}
              onClick={() => select(t.id)}
              onKeyDown={(e) => onKey(e, t.id)}
            >
              <line x1={tx} y1={ty + 12} x2={tx} y2={TRACK_Y} stroke={`var(${t.colorVar})`} strokeWidth={2} />
              <rect className="train-body" x={tx - 22} y={ty - 13} width={44} height={25} rx={6} fill={`var(${t.colorVar})`} />
              <text className="train-label" x={tx} y={ty + 4} textAnchor="middle">
                {t.id.replace('VLT-', '')}
              </text>
              <text className="train-dev" x={tx} y={ty - 19} textAnchor="middle" fill={devColor}>
                {formatDev(t.dev)}
                {t.hold ? ' ‖' : ''}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function fleetStatus(t: TrainState): { dot: 'ok' | 'warn' | 'crit'; text: string; restrictionId?: string } {
  if (!t.hold) return { dot: 'ok', text: 'em marcha' };
  if (t.hold.kind === 'restriction') return { dot: 'crit', text: 'retido', restrictionId: t.hold.restrictionId };
  return { dot: 'warn', text: `aguarda ${t.hold.trainId}` };
}

function FleetTable() {
  const state = useCcoState();
  const dispatch = useCcoDispatch();
  const canOperate = state.operator !== null;
  const lastTsp = (trainId: string) => state.tsp.find((d) => d.train === trainId);

  return (
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
            <th scope="col">
              <span className="sr-only">Ações</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {state.trains.map((t) => {
            const selected = state.selectedTrain === t.id;
            const tsp = lastTsp(t.id);
            const status = fleetStatus(t);
            return (
              <tr
                key={t.id}
                className={selected ? 'selected' : undefined}
                onClick={() => dispatch({ type: 'SELECT_TRAIN', trainId: selected ? null : t.id })}
              >
                <td>
                  <span className="legend-swatch" style={{ background: `var(${t.colorVar})` }} />
                  <span className="mono strong">{t.id}</span>
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
                <td className="r">
                  <button
                    type="button"
                    className="small"
                    disabled={!canOperate}
                    aria-label={`Chamar condutor do ${t.id} via rádio`}
                    title={canOperate ? `Chamar condutor do ${t.id} via rádio` : 'Identifique-se no topo para operar'}
                    onClick={(e) => {
                      e.stopPropagation();
                      dispatch({ type: 'RADIO_CALL', trainId: t.id, at: stamp() });
                    }}
                  >
                    Rádio
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function Schematic() {
  const state = useCcoState();
  return (
    <Card title="Linha 2 — Loop Centro Histórico" meta={`${state.trains.length} composições`} actions={<SimControls />}>
      <LineSvg />
      <div className="legend-row">
        {state.trains.map((t) => (
          <span className="legend-chip" key={t.id}>
            <span className="legend-swatch" style={{ background: `var(${t.colorVar})` }} />
            {t.id}
          </span>
        ))}
        <span className="legend-chip">
          <span className="legend-swatch round" style={{ background: 'var(--s-crit)' }} />
          restrição ativa
        </span>
        <span className="legend-chip">
          <span className="mono strong">‖</span> composição parada
        </span>
      </div>
      <FleetTable />
    </Card>
  );
}
