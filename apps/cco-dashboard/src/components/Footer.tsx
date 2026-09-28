export function Footer() {
  return (
    <footer className="footer">
      <div className="footer-legend">
        <span>
          <span className="dot" style={{ background: 'var(--s-good)' }} />
          SIL 2/4 — autoridade vital
        </span>
        <span>
          <span className="dot" style={{ background: 'var(--s-warn)' }} />
          Integridade Básica — sem autoridade vital
        </span>
        <span>
          <span className="dot" style={{ background: 'var(--s-crit)' }} />
          crítico
        </span>
      </div>
      <div>RailSentinel · Fase 2 · dados mockados para demonstração</div>
    </footer>
  );
}
