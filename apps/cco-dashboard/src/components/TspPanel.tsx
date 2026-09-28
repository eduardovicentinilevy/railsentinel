import { Card } from './Card';
import type { TspAction } from '../data/mock';
import { useCcoState } from '../state/CcoProvider';

const ACTION: Record<TspAction, { tone: string; label: string }> = {
  grant: { tone: 'ok', label: 'Concedida' },
  revoke: { tone: 'warn', label: 'Suspensa' },
  denied: { tone: 'crit', label: 'Recusada' },
  idle: { tone: 'off', label: 'Em espera' },
};

export function TspPanel() {
  const { tsp } = useCcoState();
  return (
    <Card title="Prioridade semafórica · NTCIP 1202" meta={`${tsp.length} cruzamentos`} flush>
      {tsp.map((t) => {
        const a = ACTION[t.action];
        return (
          <div className="tsp-row" key={t.crossing}>
            <span className={`status-dot ${a.tone}`} />
            <div className="tsp-head">
              <span className="mono strong">{t.crossing}</span>
              {t.train !== '—' && <span className="chip mono">{t.train === '*' ? 'todas' : t.train}</span>}
              {t.strategy && <span className="mono muted">{t.strategy}</span>}
            </div>
            <span className="mono muted tsp-time">{t.at}</span>
            <p className="tsp-sub">
              <span className={`tsp-action ${a.tone}`}>{a.label}</span> — {t.reason}
            </p>
          </div>
        );
      })}
    </Card>
  );
}
