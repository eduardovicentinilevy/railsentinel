import { useState, type FormEvent } from 'react';
import { Modal } from './common/Modal';
import { SECTIONS } from '../data/mock';
import { stamp, useCcoDispatch, useCcoState } from '../state/CcoProvider';
import { normalizeOperatorId } from '../state/reducer';
import type { RestrictionState } from '../state/types';
import { useUi } from '../ui/UiProvider';

function ReleaseForm({ restriction, onClose }: { restriction: RestrictionState; onClose: () => void }) {
  const { operator, trains } = useCcoState();
  const dispatch = useCcoDispatch();
  const [cctv, setCctv] = useState(false);
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);

  const section = SECTIONS.find((s) => s.id === restriction.sectionId);
  const held = trains.filter((t) => t.hold?.kind === 'restriction' && t.hold.restrictionId === restriction.id);
  const formId = `release-${restriction.id}`;

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!operator) return setError('Posto sem operador: identifique-se antes de liberar.');
    if (!cctv) return setError('Confirme a verificação no CFTV antes de liberar.');
    if (normalizeOperatorId(typed) !== operator) return setError('A matrícula não confere com o operador do posto.');
    dispatch({ type: 'RESTRICTION_CLEAR', restrictionId: restriction.id, confirmOperator: typed, cctvVerified: true, at: stamp() });
    onClose();
  }

  return (
    <Modal
      eyebrow={`Liberação de seção · ${restriction.id}`}
      title={`Liberar ${restriction.sectionId}${section ? ` · ${section.from}–${section.to}` : ''}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" form={formId} className="primary" disabled={!cctv || typed.trim() === ''}>
            Liberar seção
          </button>
        </>
      }
    >
      <form id={formId} className="release-form" onSubmit={submit}>
        <div className="release-summary">
          <span className="restr-kind">{restriction.kind}</span>
          <p>{restriction.reason}</p>
          <p className="muted">
            Ativa desde <span className="mono">{restriction.createdAt}</span>
            {held.length > 0 && (
              <>
                {' · '}retidas antes da seção: <strong className="mono">{held.map((t) => t.id).join(', ')}</strong>
              </>
            )}
          </p>
        </div>

        <label className="check-row">
          <input
            type="checkbox"
            checked={cctv}
            onChange={(e) => {
              setCctv(e.target.checked);
              setError(null);
            }}
          />
          <span>
            Verifiquei no CFTV que o gabarito da seção está livre.
            <small>Um "cleared" da borda nunca reabre a via sozinho.</small>
          </span>
        </label>

        <label className="field">
          <span className="field-label">Matrícula do operador do posto</span>
          <input
            data-autofocus
            className={error?.startsWith('A matrícula') ? 'invalid' : undefined}
            value={typed}
            onChange={(e) => {
              setTyped(e.target.value);
              setError(null);
            }}
            placeholder={operator ?? 'matrícula'}
            aria-invalid={error?.startsWith('A matrícula') ?? false}
            autoComplete="off"
          />
        </label>

        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}

export function ReleaseDialog() {
  const { releaseTarget, closeRelease } = useUi();
  const { restrictions } = useCcoState();
  const restriction = restrictions.find((r) => r.id === releaseTarget && r.cleared === null);
  if (!restriction) return null;
  return <ReleaseForm key={restriction.id} restriction={restriction} onClose={closeRelease} />;
}
