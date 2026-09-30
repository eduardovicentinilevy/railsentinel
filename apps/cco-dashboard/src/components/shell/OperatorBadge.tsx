import { useState, type FormEvent } from 'react';
import { Icon } from '../Icon';
import { stamp, useCcoDispatch, useCcoState } from '../../state/CcoProvider';
import { isValidOperatorId } from '../../state/reducer';

/** Crachá do posto: quem opera, desde quando, e a troca de turno. */
export function OperatorBadge({ compact = false }: { compact?: boolean }) {
  const { operator, operatorSince } = useCcoState();
  const dispatch = useCcoDispatch();
  const [draft, setDraft] = useState('');
  const [invalid, setInvalid] = useState(false);

  if (operator) {
    return (
      <div className={`operator-badge${compact ? ' compact' : ''}`}>
        <span className="operator-avatar" aria-hidden="true">
          <Icon name="user" size={compact ? 15 : 17} />
        </span>
        <span className="operator-text">
          <span className="operator-label">Operador do posto</span>
          <span className="operator-id mono">{operator}</span>
          {!compact && operatorSince && <span className="operator-since">desde {operatorSince}</span>}
        </span>
        <button
          type="button"
          className="icon-btn"
          onClick={() => dispatch({ type: 'LOGOUT', at: stamp() })}
          aria-label={`Encerrar posto de ${operator}`}
          title="Sair do posto"
        >
          <Icon name="logout" size={16} />
        </button>
      </div>
    );
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!isValidOperatorId(draft)) {
      setInvalid(true);
      return;
    }
    dispatch({ type: 'LOGIN', operator: draft, at: stamp() });
    setDraft('');
    setInvalid(false);
  }

  return (
    <form className={`operator-badge login${compact ? ' compact' : ''}`} onSubmit={submit}>
      <span className="operator-warning">
        <span className="dot" /> Posto sem operador — comandos bloqueados
      </span>
      <div className="operator-login-row">
        <input
          className={invalid ? 'invalid' : undefined}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setInvalid(false);
          }}
          placeholder="matrícula"
          aria-label="Matrícula do operador"
          aria-invalid={invalid}
        />
        <button type="submit" className="primary">
          Assumir posto
        </button>
      </div>
    </form>
  );
}
