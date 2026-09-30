import { useState } from 'react';
import { Card } from '../components/Card';
import { FilterChips } from '../components/common/FilterChips';
import { LogList } from '../components/EventLog';
import { Icon } from '../components/Icon';
import { useCcoState } from '../state/CcoProvider';
import type { LogKind } from '../state/types';
import { normalize } from '../ui/text';

type LogFilter = 'todos' | 'comandos' | LogKind;

export function LogView() {
  const { log } = useCcoState();
  const [filter, setFilter] = useState<LogFilter>('todos');
  const [query, setQuery] = useState('');

  const byKind = (f: LogFilter) =>
    log.filter((e) => f === 'todos' || (f === 'comandos' ? e.kind === 'action' || e.kind === 'ack' || e.kind === 'clear' : e.kind === f));
  const q = normalize(query.trim());
  const entries = byKind(filter).filter((e) => !q || normalize(`${e.text} ${e.operator ?? ''} ${e.at}`).includes(q));

  return (
    <div className="view">
      <Card
        title="Registro do turno"
        meta={`${entries.length} de ${log.length} eventos`}
        actions={
          <FilterChips
            label="Filtrar registro"
            value={filter}
            onChange={setFilter}
            options={[
              { key: 'todos', label: 'Todos', count: log.length },
              { key: 'comandos', label: 'Comandos', count: byKind('comandos').length },
              { key: 'system', label: 'Sistema', count: byKind('system').length },
              { key: 'session', label: 'Posto', count: byKind('session').length },
            ]}
          />
        }
        note="Toda ação de comando é atribuída ao operador do posto (IEC 62443 — rastreabilidade). O registro nunca é editado."
        flush
      >
        <div className="log-search">
          <Icon name="search" size={16} />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar no registro: composição, seção, matrícula, horário…"
            aria-label="Buscar no registro"
          />
        </div>
        <LogList entries={entries} fill />
      </Card>
    </div>
  );
}
