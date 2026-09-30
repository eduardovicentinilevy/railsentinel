import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { Card } from '../Card';
import { useElementWidth } from '../../hooks/useElementWidth';
import { STOPS } from '../../data/mock';
import { useCcoDispatch, useCcoState } from '../../state/CcoProvider';
import { activeRestrictions, formatDev, holdLabel } from '../../state/selectors';
import type { SimRate } from '../../state/types';

/** abaixo disto os rótulos das paradas colidem: o esquema rola em vez de encolher */
const MIN_W = 620;
const PAD = 44;
const TRACK_Y = 96;
const VIEW_Y = 40;
const VIEW_H = 108;

const RATES: Array<{ rate: SimRate; label: string }> = [
  { rate: 0, label: 'Pausa' },
  { rate: 1, label: '1×' },
  { rate: 10, label: '10×' },
];

export function SimControls() {
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

/** Esquema do loop: paradas, restrições ativas e composições selecionáveis. */
export function LineDiagram() {
  const state = useCcoState();
  const dispatch = useCcoDispatch();
  const restrictions = activeRestrictions(state);
  const scrollRef = useRef<HTMLDivElement>(null);
  // desenhado na largura medida (sem escala): o texto fica no mesmo tamanho em qualquer tela
  const measured = useElementWidth(scrollRef, 760);
  const W = Math.max(MIN_W, measured);
  const x = (t: number) => PAD + t * (W - PAD * 2);

  const select = (id: string) => dispatch({ type: 'SELECT_TRAIN', trainId: state.selectedTrain === id ? null : id });
  const onKey = (e: KeyboardEvent, id: string) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      select(id);
    }
  };

  return (
    <>
      <div className="schematic-scroll" ref={scrollRef}>
        <svg width={W} height={VIEW_H} viewBox={`0 ${VIEW_Y} ${W} ${VIEW_H}`} role="group" aria-label="Esquema da Linha 2 com posição das composições">
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
    </>
  );
}

export function LineCard({ title = 'Esquema da linha', actions }: { title?: string; actions?: ReactNode }) {
  const { trains } = useCcoState();
  return (
    <Card title={title} meta={`${trains.length} composições · ${STOPS.length} paradas`} actions={actions ?? <SimControls />}>
      <LineDiagram />
    </Card>
  );
}
