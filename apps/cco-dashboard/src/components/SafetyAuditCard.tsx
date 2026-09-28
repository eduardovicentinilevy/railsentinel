export function SafetyAuditCard() {
  return (
    <section className="card">
      <div className="card-head">
        <h2>Auditoria de segurança</h2>
      </div>
      <div className="card-body">
        <div className="safety-empty">
          <span className="safety-badge">0</span>
          <div>
            <div className="row-title" style={{ fontSize: 13 }}>
              Nenhuma violação de partição bloqueada
            </div>
            <div className="row-sub">SafetyGuard ativo desde o início do turno · EN 50716</div>
          </div>
        </div>
      </div>
    </section>
  );
}
