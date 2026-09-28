import { useState, type FormEvent } from 'react';
import { stamp, useCcoDispatch, useCcoState } from '../state/CcoProvider';
import { normalizeOperatorId } from '../state/reducer';
import { activeRestrictions } from '../state/selectors';
import type { RestrictionState } from '../state/types';
import { SECTIONS } from '../data/mock';

function RestrictionCard({ restriction }: { restriction: RestrictionState }) {
  const { operator, trains } = useCcoState();
  const dispatch = useCcoDispatch();
  const [formOpen, setFormOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [mismatch, setMismatch] = useState(false);

  const section = SECTIONS.find((s) => s.id === restriction.sectionId);
  const held = trains.filter((t) => t.hold?.kind === 'restriction' && t.hold.restrictionId === restriction.id);
  const cleared = restriction.cleared;

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!operator || normalizeOperatorId(typed) !== operator) {
      setMismatch(true);
      return;
    }
    dispatch({ type: 'RESTRICTION_CLEAR', restrictionId: restriction.id, confirmOperator: typed, at: stamp() });
    setFormOpen(false);
    setTyped('');
  }

  return (
    <div className={`restr-card${cleared ? ' cleared' : ''}`}>
      <div className="restr-title">
        {restriction.kind} · {restriction.sectionId}
        {section && (
          <span className="restr-section">
            {' '}
            {section.from}–{section.to}
          </span>
        )}
      </div>
      <div className="restr-body">{restriction.reason}</div>
      <div className="chiprow">
        <span className="chip mono">{restriction.id}</span>
        <span className={`chip ${restriction.cls === 'basic' ? 'basic' : 'sil'}`}>{restriction.cls === 'basic' ? 'Integridade Básica' : 'SIL'}</span>
        <span className="chip mono">desde {restriction.createdAt}</span>
        {held.map((t) => (
          <span className="chip held mono" key={t.id}>
            ‖ {t.id} retido
          </span>
        ))}
      </div>

      {cleared ? (
        <div className="cleared-note">
          ✓ Seção liberada por {cleared.by} às {cleared.at}
        </div>
      ) : formOpen ? (
        <form className="ack-form" onSubmit={submit}>
          <label className="ack-label" htmlFor={`confirm-${restriction.id}`}>
            Confirme digitando sua matrícula. Verifique no CFTV que o gabarito está livre antes de liberar.
          </label>
          <div className="ack-row">
            <input
              id={`confirm-${restriction.id}`}
              className={mismatch ? 'invalid' : undefined}
              value={typed}
              onChange={(e) => {
                setTyped(e.target.value);
                setMismatch(false);
              }}
              placeholder="matrícula do operador"
              aria-invalid={mismatch}
              autoFocus
            />
            <button type="submit" className="primary">
              Liberar seção
            </button>
            <button type="button" className="ghost" onClick={() => setFormOpen(false)}>
              Cancelar
            </button>
          </div>
          {mismatch && <div className="form-error">A matrícula não confere com o operador do posto.</div>}
        </form>
      ) : (
        <div className="chiprow">
          <button
            type="button"
            className="primary"
            disabled={!operator}
            title={operator ? undefined : 'Identifique-se no topo para operar'}
            onClick={() => setFormOpen(true)}
          >
            Confirmar liberação…
          </button>
        </div>
      )}
    </div>
  );
}

export function RestrictionsPanel() {
  const state = useCcoState();
  const active = activeRestrictions(state).length;
  return (
    <section className="card">
      <div className="card-head">
        <h2>Restrições de via</h2>
        <span className="card-head-spacer" />
        <span className="count">
          {active} ativa{active === 1 ? '' : 's'}
        </span>
      </div>
      <div className="card-body stack">
        {state.restrictions.map((r) => (
          <RestrictionCard restriction={r} key={r.id} />
        ))}
      </div>
      <div className="card-foot">
        Restrições são <em>advisory</em> e nunca expiram sozinhas — só a confirmação do operador libera.
      </div>
    </section>
  );
}
