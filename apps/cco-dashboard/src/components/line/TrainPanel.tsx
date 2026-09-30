import { Card } from '../Card';
import type { TspAction } from '../../data/mock';
import { Icon } from '../Icon';
import { fleetStatus } from './FleetCard';
import { nextStop, sectionAt } from '../../domain/line';
import { regulationAdvice } from '../../domain/regulation';
import { stamp, useCcoDispatch, useCcoState } from '../../state/CcoProvider';
import { formatDev, holdLabel, latestTsp } from '../../state/selectors';

const TSP_WORD: Record<TspAction, string> = { grant: 'concedida', revoke: 'suspensa', denied: 'recusada', idle: 'em espera' };

const NOTE = 'Sem comando vital neste console: freio e sinalização pertencem ao intertravamento SIL 4 (EN 50716).';

/** Posto da composição selecionada: leitura e comandos de Integridade Básica. */
export function TrainPanel() {
  const state = useCcoState();
  const dispatch = useCcoDispatch();
  const train = state.trains.find((t) => t.id === state.selectedTrain);

  if (!train) {
    return (
      <Card title="Posto da composição" meta="nenhuma selecionada" note={NOTE}>
        <div className="empty">
          <p>Selecione uma composição no esquema ou na tabela para ver o posto e os comandos.</p>
          <div className="empty-actions">
            {state.trains.map((t) => (
              <button type="button" key={t.id} onClick={() => dispatch({ type: 'SELECT_TRAIN', trainId: t.id })}>
                <span className="legend-swatch" style={{ background: `var(${t.colorVar})` }} />
                {t.id}
              </button>
            ))}
          </div>
        </div>
      </Card>
    );
  }

  const status = fleetStatus(train);
  const advice = regulationAdvice(train);
  const tsp = latestTsp(state, train.id);
  const canOperate = state.operator !== null;
  const blocked = canOperate ? undefined : 'Identifique-se no posto para operar';
  const devClass = train.dev > 0.5 ? 'late' : train.dev < -0.5 ? 'early' : '';

  return (
    <Card title="Posto da composição" meta={holdLabel(train.hold)} note={NOTE}>
      <div className="train-head">
        <span className="train-chip" style={{ background: `var(${train.colorVar})` }}>
          {train.id.replace('VLT-', '')}
        </span>
        <div>
          <span className="eyebrow">Composição</span>
          <h3 className="mono">{train.id}</h3>
        </div>
        <span className={`train-dev-big mono ${devClass}`}>{formatDev(train.dev)}</span>
      </div>

      <dl className="kv">
        <div>
          <dt>Seção</dt>
          <dd className="mono">{sectionAt(train.t).id}</dd>
        </div>
        <div>
          <dt>Próxima parada</dt>
          <dd>{nextStop(train.t).name}</dd>
        </div>
        <div>
          <dt>Estado</dt>
          <dd>
            <span className={`status-dot inline ${status.dot}`} />
            {status.text}
            {status.restrictionId && ` (${status.restrictionId})`}
          </dd>
        </div>
        <div>
          <dt>Lotação</dt>
          <dd>{train.occ}</dd>
        </div>
        <div>
          <dt>Último TSP</dt>
          <dd>{tsp ? `${tsp.crossing.replace('XC-', '')} · ${TSP_WORD[tsp.action]}` : '—'}</dd>
        </div>
      </dl>

      <div className={`advice ${advice.kind}`}>
        <span className="advice-label">Regulação de headway</span>
        <span className="advice-text">
          {advice.kind === 'hold' ? `Reter ${advice.seconds} s em ${advice.stop}` : `Sem aviso: ${advice.reason}`}
        </span>
      </div>

      <div className="panel-actions">
        <button
          type="button"
          disabled={!canOperate}
          title={blocked}
          aria-label={`Chamar condutor do ${train.id} via rádio`}
          onClick={() => dispatch({ type: 'RADIO_CALL', trainId: train.id, at: stamp() })}
        >
          <Icon name="radio" size={16} />
          Chamar condutor
        </button>
        <button
          type="button"
          className="primary"
          disabled={!canOperate || advice.kind !== 'hold'}
          title={blocked ?? (advice.kind === 'hold' ? undefined : advice.reason)}
          onClick={() => dispatch({ type: 'REGULATION_ADVICE', trainId: train.id, at: stamp() })}
        >
          <Icon name="clock" size={16} />
          Enviar aviso de regulação
        </button>
      </div>
    </Card>
  );
}
