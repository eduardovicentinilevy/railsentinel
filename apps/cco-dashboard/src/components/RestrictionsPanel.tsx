import { Card } from './Card';
import { SECTIONS } from '../data/mock';
import { useCcoState } from '../state/CcoProvider';
import { activeRestrictions } from '../state/selectors';
import type { RestrictionState } from '../state/types';
import { useUi } from '../ui/UiProvider';

function RestrictionRow({ restriction }: { restriction: RestrictionState }) {
  const { operator, trains } = useCcoState();
  const { openRelease } = useUi();
  const section = SECTIONS.find((s) => s.id === restriction.sectionId);
  const held = trains.filter((t) => t.hold?.kind === 'restriction' && t.hold.restrictionId === restriction.id);
  const cleared = restriction.cleared;

  return (
    <div className={`restr-card${cleared ? ' cleared' : ''}`}>
      <div className="restr-head">
        <span className="restr-kind">{cleared ? 'LIBERADA' : restriction.kind}</span>
        <span className="mono restr-id">{restriction.id}</span>
      </div>
      <h3 className="restr-title">
        <span className="mono">{restriction.sectionId}</span>
        {section && ` · ${section.from}–${section.to}`}
      </h3>
      <p className="restr-body">{restriction.reason}</p>
      <div className="alarm-meta">
        <span className={`chip ${restriction.cls === 'basic' ? 'basic' : 'sil'}`}>{restriction.cls === 'basic' ? 'Integridade Básica' : 'SIL'}</span>
        <span className="mono">desde {restriction.createdAt}</span>
        {held.map((t) => (
          <span className="chip held mono" key={t.id}>
            ‖ {t.id} retido
          </span>
        ))}
      </div>
      {cleared ? (
        <p className="cleared-note">
          ✓ Seção liberada por {cleared.by} às {cleared.at}, com CFTV verificado
        </p>
      ) : (
        <div className="alarm-actions">
          <button
            type="button"
            className="primary"
            disabled={!operator}
            title={operator ? undefined : 'Identifique-se no posto para operar'}
            onClick={() => openRelease(restriction.id)}
          >
            Liberar seção…
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
    <Card
      title="Restrições de via"
      meta={`${active} ativa${active === 1 ? '' : 's'}`}
      note={
        <>
          Restrições são <em>advisory</em> e nunca expiram sozinhas — só a confirmação do operador, com CFTV verificado, libera.
        </>
      }
      flush
    >
      {state.restrictions.map((r) => (
        <RestrictionRow restriction={r} key={r.id} />
      ))}
    </Card>
  );
}
