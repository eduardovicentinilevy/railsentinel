import { useState, type FormEvent } from 'react';
import { Crest } from './Crest';
import { useClock } from '../hooks/useClock';
import { useTheme, type ThemeChoice } from '../hooks/useTheme';
import { stamp, useCcoDispatch, useCcoState } from '../state/CcoProvider';
import { isValidOperatorId } from '../state/reducer';
import { edgeSummary } from '../state/selectors';

const THEME_LABEL: Record<ThemeChoice, string> = { system: 'sistema', light: 'diurno', dark: 'noturno' };

function OperatorSession() {
  const { operator } = useCcoState();
  const dispatch = useCcoDispatch();
  const [draft, setDraft] = useState('');
  const [invalid, setInvalid] = useState(false);

  if (operator) {
    return (
      <span className="operator">
        <span className="operator-label">Operador</span>
        <span className="mono operator-id">{operator}</span>
        <button type="button" className="ghost small" onClick={() => dispatch({ type: 'LOGOUT', at: stamp() })}>
          Sair
        </button>
      </span>
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
    <form className="operator login" onSubmit={submit}>
      <span className="pill crit">
        <span className="dot" />
        posto sem operador — comandos bloqueados
      </span>
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
      <button type="submit" className="primary small">
        Assumir posto
      </button>
    </form>
  );
}

export function TopBar() {
  const clock = useClock();
  const [theme, cycleTheme] = useTheme();
  const edge = edgeSummary();

  return (
    <>
      {/* Faixa vermelho / dourado / verde do brasão de Santos. Ornamental —
          nunca usada para codificar dado. */}
      <div className="brand-bar" aria-hidden="true" />
      <header className="topbar">
        <div className="brand">
          <Crest />
          <div className="brand-text">
            <span className="brand-mark">
              RAIL<span>SENTINEL</span>
            </span>
            <span className="brand-sub">CCO · VLT Baixada Santista — Linha 2 · Santos</span>
          </div>
        </div>
        <div className="topbar-spacer" />
        <div className="topbar-meta">
          <span className="pill demo">● dados de demonstração</span>
          <span className="pill good">
            <span className="dot" />
            ats-core-4f1c ATIVO · epoch 7
          </span>
          <span className={`pill ${edge.online === edge.total ? 'good' : 'neutral'}`}>
            <span className="dot" />
            {edge.online}/{edge.total} nós de borda
          </span>
          <OperatorSession />
          <button type="button" className="ghost small" onClick={cycleTheme} title="Alternar tema do posto">
            Tema: {THEME_LABEL[theme]}
          </button>
          <span className="clock" aria-label="Hora local">
            {clock}
          </span>
        </div>
      </header>
    </>
  );
}
