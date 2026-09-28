import { useMemo, useRef, useState, type PointerEvent } from 'react';
import { TRAINS } from '../data/mock';
import { useElementWidth } from '../hooks/useElementWidth';
import { useCcoState } from '../state/CcoProvider';

const H = 140;
const PAD_L = 38;
const PAD_R = 10;
const PAD_T = 10;
const PAD_B = 22;
const PLOT_H = H - PAD_T - PAD_B;
const N = 24; // 40 min em passos de ~100s
const WINDOW_MIN = 40;

interface Series {
  id: string;
  colorVar: string;
  vals: number[];
}

function seeded(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

/** Histórico mockado dos 40 min anteriores ao carregamento; o último ponto é o desvio ao vivo. */
function buildHistory(): Series[] {
  return TRAINS.map((t) => {
    const rnd = seeded(t.dev + t.t * 1000);
    const vals: number[] = [];
    let v = t.dev + (rnd() - 0.5) * 20;
    for (let i = 0; i < N - 1; i++) {
      v += (rnd() - 0.5) * 9;
      v = Math.max(-70, Math.min(140, v));
      vals.push(v);
    }
    return { id: t.id, colorVar: t.colorVar, vals };
  });
}

function signed(v: number): string {
  const r = Math.round(v);
  return `${r > 0 ? '+' : ''}${r}`;
}

export function Sparkline() {
  const { trains, selectedTrain } = useCcoState();
  const history = useMemo(buildHistory, []);
  const wrapRef = useRef<HTMLDivElement>(null);
  const W = useElementWidth(wrapRef, 700);
  const [hover, setHover] = useState<number | null>(null);

  const series = history.map((s) => ({
    ...s,
    vals: [...s.vals, trains.find((t) => t.id === s.id)?.dev ?? s.vals[s.vals.length - 1]],
  }));

  const plotW = Math.max(1, W - PAD_L - PAD_R);
  const xFor = (i: number) => PAD_L + (i / (N - 1)) * plotW;
  const maxAbs = Math.max(70, Math.ceil(Math.max(...series.flatMap((s) => s.vals).map(Math.abs)) / 10) * 10);
  const yFor = (v: number) => PAD_T + PLOT_H / 2 - (v / maxAbs) * (PLOT_H / 2);
  const gridValues = [-maxAbs, -maxAbs / 2, 0, maxAbs / 2, maxAbs];

  function handleMove(e: PointerEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const i = Math.round(((e.clientX - rect.left - PAD_L) / plotW) * (N - 1));
    setHover(Math.max(0, Math.min(N - 1, i)));
  }

  const crosshairX = hover !== null ? xFor(hover) : 0;
  const minsAgo = hover !== null ? Math.round((N - 1 - hover) * (WINDOW_MIN / (N - 1))) : 0;
  const tipLeft = Math.min(W - 130, Math.max(0, crosshairX + 10));

  return (
    <section className="card">
      <div className="card-head">
        <h2>Desvio de tabela horária — últimos {WINDOW_MIN} min</h2>
        <span className="card-head-spacer" />
        <span className="count">setpoint 474s · ciclo/3</span>
      </div>
      <div className="card-body">
        <div className="spark-legend">
          {series.map((s) => (
            <span className="legend-chip" key={s.id}>
              <span className="legend-swatch" style={{ background: `var(${s.colorVar})` }} />
              {s.id}
            </span>
          ))}
          <span className="spark-polarity">
            <span style={{ color: 'var(--d-late)' }}>▲</span> atrasado · <span style={{ color: 'var(--d-early)' }}>▼</span> adiantado
          </span>
        </div>
        <div className="spark-wrap" ref={wrapRef}>
          <svg
            className="spark"
            width={W}
            height={H}
            viewBox={`0 0 ${W} ${H}`}
            onPointerMove={handleMove}
            onPointerLeave={() => setHover(null)}
            role="img"
            aria-label="Desvio de tabela horária por composição nos últimos 40 minutos"
          >
            {gridValues.map((gv) => {
              const gy = yFor(gv);
              return (
                <g key={gv}>
                  <line className={gv === 0 ? 'spark-zero' : 'spark-grid'} x1={PAD_L} y1={gy} x2={W - PAD_R} y2={gy} />
                  <text className="spark-axis-label" x={PAD_L - 6} y={gy + 3} textAnchor="end">
                    {signed(gv)}s
                  </text>
                </g>
              );
            })}
            {[0, 10, 20, 30, 40].map((m) => (
              <text
                key={m}
                className="spark-axis-label"
                x={xFor(((WINDOW_MIN - m) / WINDOW_MIN) * (N - 1))}
                y={H - 6}
                textAnchor={m === 0 ? 'end' : 'middle'}
              >
                {m === 0 ? 'agora' : `-${m} min`}
              </text>
            ))}

            {series.map((s) => {
              const d = s.vals.map((v, i) => `${i === 0 ? 'M' : 'L'}${xFor(i).toFixed(1)} ${yFor(v).toFixed(1)}`).join(' ');
              const dimmed = selectedTrain !== null && selectedTrain !== s.id;
              return (
                <g key={s.id} opacity={dimmed ? 0.22 : 1}>
                  <path
                    d={d}
                    fill="none"
                    stroke={`var(${s.colorVar})`}
                    strokeWidth={selectedTrain === s.id ? 2.5 : 2}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                  />
                  <circle cx={xFor(N - 1)} cy={yFor(s.vals[N - 1])} r={4} fill={`var(${s.colorVar})`} stroke="var(--surface)" strokeWidth={2} />
                </g>
              );
            })}

            <line className={`spark-crosshair${hover !== null ? ' show' : ''}`} x1={crosshairX} y1={PAD_T} x2={crosshairX} y2={H - PAD_B} />
          </svg>
          <div className={`spark-tooltip${hover !== null ? ' show' : ''}`} style={{ left: tipLeft, top: 6 }}>
            {hover !== null && (
              <>
                <div className="spark-tooltip-head">{minsAgo === 0 ? 'agora' : `há ${minsAgo} min`}</div>
                {series.map((s) => (
                  <div key={s.id} className="spark-tooltip-row">
                    <span>
                      <span className="legend-swatch" style={{ background: `var(${s.colorVar})` }} />
                      {s.id}
                    </span>
                    <span>{signed(s.vals[hover])}s</span>
                  </div>
                ))}
              </>
            )}
          </div>
        </div>
      </div>
      <div className="card-foot">
        Regulador Kp=0.51 Ki=0.017 · ρ modal = 0.708 · fonte: <span className="mono">docs/ESTABILIDADE.md</span>
      </div>
    </section>
  );
}
