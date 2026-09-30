import type { ReactNode } from 'react';
import { Card } from './Card';
import { useCcoState } from '../state/CcoProvider';
import type { LogEntry, LogKind } from '../state/types';

const KIND_LABEL: Record<LogKind, string> = {
  system: 'sistema',
  session: 'posto',
  ack: 'reconhec.',
  action: 'comando',
  clear: 'liberação',
};

export function LogList({ entries, fill = false }: { entries: LogEntry[]; fill?: boolean }) {
  return (
    <ol className={`event-log${fill ? ' fill' : ''}`} aria-live="polite" aria-label="Registro de eventos do turno, mais recente primeiro">
      {entries.length === 0 && <li className="empty">Nenhum evento neste filtro.</li>}
      {entries.map((e) => (
        <li key={e.seq} className="event">
          <span className="event-time mono">{e.at}</span>
          <span className={`event-kind ${e.kind}`}>{KIND_LABEL[e.kind]}</span>
          <span className="event-text">
            {e.text}
            {e.operator && e.kind !== 'session' && <span className="event-op mono"> · {e.operator}</span>}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** Trecho mais recente do registro, para painéis que não são o registro completo. */
export function EventLog({ limit, actions }: { limit: number; actions?: ReactNode }) {
  const { log } = useCcoState();
  return (
    <Card title="Últimos eventos" meta={`${log.length} no turno`} actions={actions} flush>
      <LogList entries={log.slice(0, limit)} />
    </Card>
  );
}
