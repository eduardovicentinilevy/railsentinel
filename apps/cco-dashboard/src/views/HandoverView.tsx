import { useEffect, useRef, useState } from 'react';
import { Card } from '../components/Card';
import { Icon } from '../components/Icon';
import { PendingList } from '../components/PendingList';
import { useClock } from '../hooks/useClock';
import { useCcoState } from '../state/CcoProvider';
import { pendingItems, shiftTally } from '../state/selectors';
import { handoverText } from '../ui/handover';

type CopyState = 'idle' | 'copied' | 'selected';

export function HandoverView() {
  const state = useCcoState();
  const now = useClock();
  const tally = shiftTally(state);
  const pending = pendingItems(state).length;
  const text = handoverText(state, now.slice(0, 5));
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const [copy, setCopy] = useState<CopyState>('idle');

  useEffect(() => {
    if (copy === 'idle') return;
    const id = setTimeout(() => setCopy('idle'), 2500);
    return () => clearTimeout(id);
  }, [copy]);

  async function copyText() {
    try {
      await navigator.clipboard.writeText(text);
      setCopy('copied');
    } catch {
      // área de transferência bloqueada: seleciona o texto para Ctrl+C
      areaRef.current?.select();
      setCopy('selected');
    }
  }

  return (
    <div className="view">
      <div className="split">
        <Card title="Resumo do posto" meta={state.operatorSince ? `desde ${state.operatorSince}` : 'posto vago'}>
          <div className="handover-who">
            <span className="eyebrow">Operador</span>
            <strong className="mono">{state.operator ?? '—'}</strong>
          </div>
          <div className="tally">
            <div>
              <span className="tally-n mono">{tally.ack}</span>
              <span className="tally-l">reconhecimentos</span>
            </div>
            <div>
              <span className="tally-n mono">{tally.clear}</span>
              <span className="tally-l">liberações</span>
            </div>
            <div>
              <span className="tally-n mono">{tally.action}</span>
              <span className="tally-l">comandos</span>
            </div>
            <div className={pending > 0 ? 'crit' : ''}>
              <span className="tally-n mono">{pending}</span>
              <span className="tally-l">pendências</span>
            </div>
          </div>
        </Card>
        <Card title="Pendências para quem assume" meta={pending === 0 ? 'nenhuma' : `${pending}`} flush>
          <PendingList actionable={false} />
        </Card>
      </div>

      <Card
        title="Texto para o livro de ocorrências"
        meta="gerado agora"
        actions={
          <button type="button" className="small" onClick={copyText}>
            <Icon name={copy === 'copied' ? 'check' : 'copy'} size={15} />
            {copy === 'copied' ? 'Copiado' : copy === 'selected' ? 'Selecionado — use Ctrl+C' : 'Copiar'}
          </button>
        }
      >
        <textarea ref={areaRef} className="handover-text mono" readOnly value={text} rows={Math.min(18, text.split('\n').length + 1)} aria-label="Texto da passagem de turno" />
      </Card>
    </div>
  );
}
