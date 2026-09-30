import { Card } from '../components/Card';
import { TspPanel } from '../components/TspPanel';
import { useCcoState } from '../state/CcoProvider';
import { tspServiceRate } from '../state/selectors';

export function TspView() {
  const state = useCcoState();
  const rate = tspServiceRate(state);
  const count = (action: string) => state.tsp.filter((d) => d.action === action).length;

  return (
    <div className="view">
      <section className="kpis four" aria-label="Indicadores de prioridade semafórica">
        <div className="kpi">
          <span className="kpi-label">Atendimento</span>
          <span className="kpi-value">
            {rate === null ? '—' : Math.round(rate * 100)}
            <span className="kpi-unit">%</span>
          </span>
          <span className="kpi-note">concedidas ÷ (concedidas + recusadas)</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Concedidas</span>
          <span className="kpi-value">{count('grant')}</span>
          <span className="kpi-note">phase call · extensão de verde</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Recusadas</span>
          <span className="kpi-value">{count('denied')}</span>
          <span className="kpi-note">composição adiantada cede ao trânsito</span>
        </div>
        <div className={`kpi${count('revoke') > 0 ? ' crit' : ''}`}>
          <span className="kpi-label">Suspensas</span>
          <span className="kpi-value">{count('revoke')}</span>
          <span className="kpi-note">obstrução a jusante</span>
        </div>
      </section>

      <div className="split wide-left">
        <TspPanel />
        <Card title="Regra de autoridade" meta="EN 50716">
          <div className="rule">
            <p>
              <strong>Retirar prioridade é permitido à visão computacional; conceder não é.</strong>
            </p>
            <p>
              Retirar só remove uma ação permissiva: o pior caso é um VLT parando num sinal que poderia estar verde. Conceder cria
              permissão, e isso exige a cadeia de Integridade SIL.
            </p>
            <ul className="rule-list">
              <li>
                <span className="status-dot inline ok" />
                <strong>Conceder</strong> — só o ats-core, a partir de posição e tabela.
              </li>
              <li>
                <span className="status-dot inline warn" />
                <strong>Suspender</strong> — qualquer detecção de obstrução a jusante.
              </li>
              <li>
                <span className="status-dot inline crit" />
                <strong>Recusar</strong> — composição adiantada cede ao trânsito.
              </li>
            </ul>
          </div>
        </Card>
      </div>
    </div>
  );
}
