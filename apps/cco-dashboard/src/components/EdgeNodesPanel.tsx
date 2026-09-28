import { EDGE_NODES } from '../data/mock';
import { edgeSummary } from '../state/selectors';

export function EdgeNodesPanel() {
  const { online, total } = edgeSummary();
  return (
    <section className="card">
      <div className="card-head">
        <h2>Nós de borda · Jetson Orin</h2>
        <span className="card-head-spacer" />
        <span className="count">
          {online}/{total} ok
        </span>
      </div>
      <div className="card-body">
        {EDGE_NODES.map((n) => (
          <div className="row-item" key={n.id}>
            <span className={`status-dot ${n.status === 'ok' ? 'ok' : 'crit'}`} />
            <div className="row-main">
              <div className="row-title mono">{n.id}</div>
              {n.status === 'ok' ? (
                <div className="row-sub">
                  ok · {n.fps?.toFixed(1)} fps · enlace {n.link}
                </div>
              ) : (
                <div className="row-sub offline">OFFLINE · cobertura perdida neste trecho</div>
              )}
            </div>
          </div>
        ))}
      </div>
      <div className="card-foot">Nó offline = perda de cobertura. Ausência de alerta não significa via livre.</div>
    </section>
  );
}
