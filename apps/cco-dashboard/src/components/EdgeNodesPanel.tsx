import { Card } from './Card';
import { EDGE_NODES } from '../data/mock';
import { edgeSummary } from '../state/selectors';

export function EdgeNodesPanel() {
  const { online, total } = edgeSummary();
  return (
    <Card
      title="Nós de borda · Jetson Orin"
      meta={`${online}/${total} online`}
      note="Nó offline = perda de cobertura. Ausência de alerta não significa via livre."
    >
      <ul className="edge-grid">
        {EDGE_NODES.map((n) => (
          <li className={`edge-tile${n.status === 'ok' ? '' : ' off'}`} key={n.id}>
            <span className={`status-dot ${n.status === 'ok' ? 'ok' : 'crit'}`} />
            <span className="mono edge-id">{n.id}</span>
            <span className="edge-sub">
              {n.status === 'ok' ? `${n.fps?.toFixed(1)} fps · enlace ${n.link}` : 'OFFLINE · sem cobertura'}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
