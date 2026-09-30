import { useState } from 'react';
import { AlarmsPanel, type AlarmFilter } from '../components/AlarmsPanel';
import { FilterChips } from '../components/common/FilterChips';
import { RestrictionsPanel } from '../components/RestrictionsPanel';
import { useCcoState } from '../state/CcoProvider';
import { alarmSummary } from '../state/selectors';

export function AlarmsView() {
  const state = useCcoState();
  const s = alarmSummary(state);
  const [filter, setFilter] = useState<AlarmFilter>('todos');

  return (
    <div className="view">
      <div className="split wide-left">
        <AlarmsPanel
          filter={filter}
          actions={
            <FilterChips
              label="Filtrar alarmes"
              value={filter}
              onChange={setFilter}
              options={[
                { key: 'todos', label: 'Todos', count: s.total },
                { key: 'pendentes', label: 'Sem reconhecimento', count: s.unacked },
                { key: 'criticos', label: 'Críticos', count: s.critical },
              ]}
            />
          }
        />
        <RestrictionsPanel />
      </div>
    </div>
  );
}
