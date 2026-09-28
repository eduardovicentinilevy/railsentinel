import { EDGE_NODES } from '../data/mock.ts';
import type { AlarmSeverity } from '../data/mock.ts';
import type { AlarmState, CcoState, HoldReason } from './types.ts';

const SEVERITY_RANK: Record<AlarmSeverity, number> = { critical: 0, major: 1, warning: 2 };

/** Não reconhecidos primeiro; dentro de cada grupo, por severidade. */
export function sortedAlarms(state: CcoState): AlarmState[] {
  return [...state.alarms].sort(
    (a, b) => Number(a.ack !== null) - Number(b.ack !== null) || SEVERITY_RANK[a.sev] - SEVERITY_RANK[b.sev],
  );
}

export function alarmSummary(state: CcoState) {
  const count = (sev: AlarmSeverity) => state.alarms.filter((a) => a.sev === sev).length;
  return {
    total: state.alarms.length,
    unacked: state.alarms.filter((a) => a.ack === null).length,
    critical: count('critical'),
    major: count('major'),
    warning: count('warning'),
  };
}

export function activeRestrictions(state: CcoState) {
  return state.restrictions.filter((r) => r.cleared === null);
}

/** Concedidas ÷ (concedidas + recusadas). Suspensões e esperas não contam como pedido. */
export function tspServiceRate(state: CcoState): number | null {
  const granted = state.tsp.filter((t) => t.action === 'grant').length;
  const denied = state.tsp.filter((t) => t.action === 'denied').length;
  return granted + denied === 0 ? null : granted / (granted + denied);
}

export function edgeSummary() {
  const online = EDGE_NODES.filter((n) => n.status === 'ok');
  return { online: online.length, total: EDGE_NODES.length, offline: EDGE_NODES.filter((n) => n.status !== 'ok') };
}

export function holdLabel(hold: HoldReason | null): string {
  if (!hold) return 'em marcha';
  return hold.kind === 'restriction'
    ? `parado — aguarda liberação de ${hold.restrictionId}`
    : `parado — aguarda ${hold.trainId} à frente`;
}

export function formatDev(dev: number): string {
  const s = Math.round(dev);
  return `${s > 0 ? '+' : ''}${s}s`;
}
