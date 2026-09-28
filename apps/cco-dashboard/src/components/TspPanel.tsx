import type { TspAction } from '../data/mock';
import { useCcoState } from '../state/CcoProvider';

const ACTION_TEXT: Record<TspAction, { dot: string; prefix: string; label: string }> = {
  grant: { dot: 'ok', prefix: 'Prioridade', label: 'concedida' },
  revoke: { dot: 'warn', prefix: 'Prioridade', label: 'suspensa' },
  denied: { dot: 'crit', prefix: 'Pedido', label: 'recusado' },
  idle: { dot: 'off', prefix: '', label: 'em espera' },
};

export function TspPanel() {
  const { tsp } = useCcoState();
  return (
    <section className="card">
      <div className="card-head">
        <h2>Prioridade semafórica · NTCIP 1202</h2>
        <span className="card-head-spacer" />
        <span className="count">{tsp.length} cruzamentos</span>
      </div>
      <div className="card-body">
        {tsp.map((t) => {
          const a = ACTION_TEXT[t.action];
          return (
            <div className="row-item" key={t.crossing}>
              <span className={`status-dot ${a.dot}`} />
              <div className="row-main">
                <div className="row-title">
                  {t.crossing}
                  <span className="chip mono">{t.train}</span>
                  {t.strategy && <span className="chip">{t.strategy}</span>}
                  <span className="chip mono push-right">{t.at}</span>
                </div>
                <div className="row-sub">
                  {a.prefix} <strong>{a.label}</strong> — {t.reason}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
