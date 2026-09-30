import { SECTIONS } from '../data/mock.ts';
import { nextStop, sectionAt } from '../domain/line.ts';
import { formatDev, holdLabel, pendingItems, shiftTally } from '../state/selectors.ts';
import type { CcoState } from '../state/types.ts';

const SEV = { critical: 'CRÍTICO', major: 'MAIOR', warning: 'AVISO' } as const;

/** Texto corrido para o livro de ocorrências do CCO — o que quem assume precisa saber. */
export function handoverText(state: CcoState, now: string): string {
  const tally = shiftTally(state);
  const pending = pendingItems(state);
  const lines = [
    'PASSAGEM DE TURNO — CCO VLT Baixada Santista · Linha 2',
    `Operador: ${state.operator ?? '(posto sem operador)'}${state.operatorSince ? ` · no posto desde ${state.operatorSince}` : ''} · gerado às ${now}`,
    `Comandos no posto: ${tally.ack} reconhecimento(s), ${tally.clear} liberação(ões), ${tally.action} comando(s)`,
    '',
    `PENDÊNCIAS (${pending.length})`,
  ];

  if (pending.length === 0) lines.push('- nenhuma');
  for (const item of pending) {
    if (item.kind === 'alarm') {
      lines.push(`- [${SEV[item.alarm.sev]}] ${item.alarm.title} (${item.alarm.id}) — sem reconhecimento desde ${item.alarm.raisedAt}`);
    } else if (item.kind === 'restriction') {
      const r = item.restriction;
      const s = SECTIONS.find((x) => x.id === r.sectionId);
      const held = item.held.length ? `; retidas: ${item.held.map((t) => t.id).join(', ')}` : '';
      lines.push(`- [RESTRIÇÃO] ${r.id} ${r.kind.toLowerCase()} em ${r.sectionId}${s ? ` (${s.from}–${s.to})` : ''} — ativa desde ${r.createdAt}${held}`);
    } else {
      lines.push(`- [BORDA] ${item.node.id} offline — sem detecção automática no trecho`);
    }
  }

  lines.push('', 'FROTA');
  for (const t of state.trains) {
    lines.push(`- ${t.id} · ${sectionAt(t.t).id} · próxima ${nextStop(t.t).name} · ${formatDev(t.dev)} · ${holdLabel(t.hold)}`);
  }
  return lines.join('\n');
}
