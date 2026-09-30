import { EDGE_NODES } from '../data/mock.ts';
import type { AlarmSeverity, EdgeNode } from '../data/mock.ts';
import type { AlarmState, CcoState, HoldReason, LogKind, RestrictionState, TrainState, TspState } from './types.ts';

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

export function latestTsp(state: CcoState, trainId: string): TspState | undefined {
  return state.tsp.find((d) => d.train === trainId);
}

export type PendingItem =
  | { kind: 'alarm'; alarm: AlarmState }
  | { kind: 'restriction'; restriction: RestrictionState; held: TrainState[] }
  | { kind: 'edge'; node: EdgeNode };

/** O que o operador precisa resolver, na ordem em que deve resolver. */
export function pendingItems(state: CcoState): PendingItem[] {
  const alarms = sortedAlarms(state)
    .filter((a) => a.ack === null)
    .map((alarm): PendingItem => ({ kind: 'alarm', alarm }));
  const restrictions = activeRestrictions(state).map(
    (restriction): PendingItem => ({
      kind: 'restriction',
      restriction,
      held: state.trains.filter((t) => t.hold?.kind === 'restriction' && t.hold.restrictionId === restriction.id),
    }),
  );
  const edges = edgeSummary().offline.map((node): PendingItem => ({ kind: 'edge', node }));
  return [...alarms, ...restrictions, ...edges];
}

/** Comandos do operador atual neste posto, por tipo. */
export function shiftTally(state: CcoState): Record<Exclude<LogKind, 'system' | 'session'>, number> {
  const mine = state.log.filter((e) => e.operator !== null && e.operator === state.operator);
  const count = (kind: LogKind) => mine.filter((e) => e.kind === kind).length;
  return { ack: count('ack'), clear: count('clear'), action: count('action') };
}

export function lineStatus(state: CcoState): 'crit' | 'warn' | 'ok' {
  const s = alarmSummary(state);
  if (activeRestrictions(state).length > 0 || state.alarms.some((a) => a.sev === 'critical' && a.ack === null)) return 'crit';
  if (s.unacked > 0 || edgeSummary().offline.length > 0) return 'warn';
  return 'ok';
}
