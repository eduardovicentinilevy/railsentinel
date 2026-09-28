import { useId, type ReactNode } from 'react';

interface CardProps {
  title: string;
  meta?: ReactNode;
  actions?: ReactNode;
  note?: ReactNode;
  /** corpo sem padding: para listas e tabelas que desenham as próprias linhas */
  flush?: boolean;
  className?: string;
  children: ReactNode;
}

export function Card({ title, meta, actions, note, flush = false, className, children }: CardProps) {
  const titleId = useId();
  return (
    <section className={className ? `card ${className}` : 'card'} aria-labelledby={titleId}>
      <header className="card-head">
        <h2 id={titleId}>{title}</h2>
        {meta !== undefined && <span className="card-meta">{meta}</span>}
        {actions}
      </header>
      <div className={flush ? 'card-body flush' : 'card-body'}>{children}</div>
      {note && <p className="card-note">{note}</p>}
    </section>
  );
}
