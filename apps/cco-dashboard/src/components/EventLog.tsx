import { useCcoState } from '../state/CcoProvider';
import type { LogKind } from '../state/types';

const KIND_LABEL: Record<LogKind, string> = {
  system: 'sistema',
  session: 'posto',
  ack: 'reconhec.',
  action: 'comando',
  clear: 'liberação',
};

export function EventLog() {
  const { log } = useCcoState();
  return (
    <section className="card">
      <div className="card-head">
        <h2>Registro do turno</h2>
        <span className="card-head-spacer" />
        <span className="count">{log.length} eventos</span>
      </div>
      <ol className="event-log" aria-live="polite" aria-label="Registro de eventos do turno, mais recente primeiro">
        {log.map((e) => (
          <li key={e.seq} className={`event ${e.kind}`}>
            <span className="event-time mono">{e.at}</span>
            <span className={`event-kind ${e.kind}`}>{KIND_LABEL[e.kind]}</span>
            <span className="event-text">
              {e.text}
              {e.operator && e.kind !== 'session' && <span className="event-op mono"> · {e.operator}</span>}
            </span>
          </li>
        ))}
      </ol>
      <div className="card-foot">Toda ação de comando é atribuída ao operador do posto (IEC 62443 — rastreabilidade).</div>
    </section>
  );
}
