import { Card } from '../components/Card';
import { EdgeNodesPanel } from '../components/EdgeNodesPanel';
import { EDGE_NODES } from '../data/mock';
import { edgeSummary } from '../state/selectors';

export function EdgeView() {
  const edge = edgeSummary();
  const fps = EDGE_NODES.filter((n) => n.fps !== null).map((n) => n.fps as number);
  const avgFps = fps.reduce((a, b) => a + b, 0) / Math.max(1, fps.length);

  return (
    <div className="view">
      <section className="kpis four" aria-label="Indicadores dos nós de borda">
        <div className={`kpi${edge.offline.length > 0 ? ' crit' : ' good'}`}>
          <span className="kpi-label">Online</span>
          <span className="kpi-value">
            {edge.online}
            <span className="kpi-unit">/ {edge.total}</span>
          </span>
          {edge.offline.length > 0 && <span className="kpi-flag crit">{edge.offline.length} sem cobertura</span>}
          <span className="kpi-note">heartbeat + LWT no broker de campo</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Quadros por segundo</span>
          <span className="kpi-value">
            {avgFps.toFixed(1)}
            <span className="kpi-unit">fps médio</span>
          </span>
          <span className="kpi-note">nós online</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Latência de inferência</span>
          <span className="kpi-value">
            4,1<span className="kpi-unit">ms p95</span>
          </span>
          <span className="kpi-note">banco de visão · docs/ESTABILIDADE.md</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Modelo</span>
          <span className="kpi-value small mono">railguard-yolo</span>
          <span className="kpi-note">v3.2.1 · Integridade Básica</span>
        </div>
      </section>

      <div className="split wide-left">
        <EdgeNodesPanel />
        <Card title="Cobertura, não certeza" meta="princípio de projeto">
          <div className="rule">
            <p>
              <strong>Ausência de alerta não é prova de via livre.</strong>
            </p>
            <p>
              Um nó que silencia vira alarme explícito de perda de cobertura, e o trecho passa a depender de CFTV e da linha de visão
              do condutor. A borda envia só metadados (~700 B por evento), assinados em Ed25519 — nunca vídeo.
            </p>
          </div>
        </Card>
      </div>
    </div>
  );
}
