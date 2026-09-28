import { stamp, useCcoDispatch, useCcoState } from '../state/CcoProvider';
import { alarmSummary, sortedAlarms } from '../state/selectors';

const SEV_LABEL = { critical: 'CRÍTICO', major: 'MAIOR', warning: 'AVISO' } as const;

export function AlarmsPanel() {
  const state = useCcoState();
  const dispatch = useCcoDispatch();
  const summary = alarmSummary(state);
  const canOperate = state.operator !== null;
  const blockedHint = canOperate ? undefined : 'Identifique-se no topo para operar';

  return (
    <section className="card">
      <div className="card-head">
        <h2>Alarmes operacionais</h2>
        <span className="card-head-spacer" />
        <span className="count">
          {summary.total} ativos · {summary.unacked} sem reconhecimento
        </span>
      </div>
      <div className="card-body">
        {sortedAlarms(state).map((a) => (
          <article className={`alarm${a.ack ? ' acked' : ' unacked'}`} key={a.id} aria-label={`Alarme ${SEV_LABEL[a.sev]}: ${a.title}`}>
            <div className={`sev-stripe ${a.sev}`} />
            <div className="alarm-body">
              <div className="alarm-title-row">
                <span className={`sev-tag ${a.sev}`}>{SEV_LABEL[a.sev]}</span>
                <span className="alarm-title">{a.title}</span>
              </div>
              <div className="alarm-detail">{a.detail}</div>
              <div className="chiprow">
                <span className={`chip ${a.cls === 'basic' ? 'basic' : 'sil'}`}>{a.cls === 'basic' ? 'Integridade Básica' : 'SIL'}</span>
                {a.conf && <span className="chip mono">conf {a.conf}</span>}
                {a.model && <span className="chip mono">{a.model}</span>}
                <span className="chip mono">{a.raisedAt}</span>
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
                    className="ghost"
                    key={label}
                    disabled={!canOperate}
                    title={blockedHint}
                    onClick={() => dispatch({ type: 'ALARM_ACTION', alarmId: a.id, label, at: stamp() })}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </article>
        ))}
      </div>
      <div className="card-foot">
        Alarmes com <span className="chip basic">Integridade Básica</span> vêm de visão computacional e não têm autoridade vital.
      </div>
    </section>
  );
}
