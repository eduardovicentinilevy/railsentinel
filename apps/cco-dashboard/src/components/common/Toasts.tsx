import { Icon, type IconName } from '../Icon';
import { useUi, type ToastTone } from '../../ui/UiProvider';

const TONE_ICON: Record<ToastTone, IconName> = { good: 'check', info: 'log', warn: 'alarm' };

export function Toasts() {
  const { toasts, dismissToast } = useUi();
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.tone}`}>
          <span className="toast-icon">
            <Icon name={TONE_ICON[t.tone]} size={16} />
          </span>
          <span className="toast-text">
            {t.text}
            {t.operator && <span className="toast-op mono"> · {t.operator}</span>}
          </span>
          <button type="button" className="icon-btn small" onClick={() => dismissToast(t.id)} aria-label="Dispensar aviso">
            <Icon name="close" size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
