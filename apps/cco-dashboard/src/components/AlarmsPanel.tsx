import type { ReactNode } from 'react';
import { Card } from './Card';
import { stamp, useCcoDispatch, useCcoState } from '../state/CcoProvider';
import { alarmSummary, sortedAlarms } from '../state/selectors';

const SEV_LABEL = { critical: 'CRÍTICO', major: 'MAIOR', warning: 'AVISO' } as const;

export type AlarmFilter = 'todos' | 'pendentes' | 'criticos';

export function AlarmsPanel({ filter = 'todos', actions }: { filter?: AlarmFilter; actions?: ReactNode }) {
  const state = useCcoState();
  const dispatch = useCcoDispatch();
  const summary = alarmSummary(state);
  const canOperate = state.operator !== null;
  const blockedHint = canOperate ? undefined : 'Identifique-se no posto para operar';
  const alarms = sortedAlarms(state).filter(
    (a) => filter === 'todos' || (filter === 'pendentes' ? a.ack === null : a.sev === 'critical'),
  );

  return (
    <Card
      title="Alarmes operacionais"
      meta={summary.unacked > 0 ? `${summary.unacked} de ${summary.total} sem reconhecimento` : `${summary.total} reconhecidos`}
      note={
        <>
          Alarmes de <span className="chip basic">Integridade Básica</span> vêm de visão computacional e não têm autoridade vital.
        </>
      }
      actions={actions}
      flush
    >
      {alarms.length === 0 && <p className="empty">Nenhum alarme neste filtro.</p>}
      {alarms.map((a) => {
        const meta = [a.conf && `conf ${a.conf}`, a.model, a.raisedAt].filter(Boolean).join(' · ');
        return (
          <article
            className={`alarm ${a.sev} ${a.ack ? 'acked' : 'unacked'}`}
            key={a.id}
            aria-label={`Alarme ${SEV_LABEL[a.sev]}${a.ack ? ', reconhecido' : ', sem reconhecimento'}: ${a.title}`}
          >
            <div className="alarm-title-row">
              <span className={`sev-tag ${a.sev}`}>{SEV_LABEL[a.sev]}</span>
              <h3 className="alarm-title">{a.title}</h3>
            </div>
            <p className="alarm-detail">{a.detail}</p>
            <div className="alarm-meta">
              <span className={`chip ${a.cls === 'basic' ? 'basic' : 'sil'}`}>{a.cls === 'basic' ? 'Integridade Básica' : 'SIL'}</span>
              <span className="mono">{meta}</span>
              {a.ack && (
                <span className="chip ack mono">
                  ✓ reconhecido · {a.ack.by} {a.ack.at}
                </span>
              )}
            </div>
            <div className="alarm-actions">
              {!a.ack && (
                <button
                  type="button"
                  className="primary"
                  disabled={!canOperate}
                  title={blockedHint}
                  onClick={() => dispatch({ type: 'ALARM_ACK', alarmId: a.id, at: stamp() })}
                >
                  Reconhecer
                </button>
              )}
              {a.actions.map((label) => (
                <button
                  type="button"
                  key={label}
                  disabled={!canOperate}
                  title={blockedHint}
                  onClick={() => dispatch({ type: 'ALARM_ACTION', alarmId: a.id, label, at: stamp() })}
                >
                  {label}
                </button>
              ))}
            </div>
          </article>
        );
      })}
    </Card>
  );
}
