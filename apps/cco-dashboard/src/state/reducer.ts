// Extensões .ts explícitas: este módulo também roda sob `node --experimental-strip-types` nos testes da raiz.
import { ALARMS, LOG, RESTRICTIONS, SECTIONS, SEED_OPERATOR, TRAINS, TSP } from '../data/mock.ts';
import { forward, isInside, wrap } from '../domain/line.ts';
import { regulationAdvice } from '../domain/regulation.ts';
import type { CcoAction, CcoState, HoldReason, LogEntry, TrainState } from './types.ts';

/** Um loop completo = 3 composições × setpoint de headway de 474 s. */
export const LOOP_PERIOD_S = 3 * 474;
export const TRAIN_SPEED = 1 / LOOP_PERIOD_S;
/** Distância mínima entre composições (marcha à vista), em fração do loop. */
export const MIN_GAP = 0.045;
/** Ponto de parada antes do início de uma seção restrita. */
export const HOLD_MARGIN = 0.012;
const LOG_CAP = 200;
const EPS = 1e-9;

export function clockString(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function normalizeOperatorId(raw: string): string {
  return raw.trim().toUpperCase();
}

export function isValidOperatorId(raw: string): boolean {
  return /^[A-Z0-9-]{2,32}$/.test(normalizeOperatorId(raw));
}

export function initialState(now: Date): CcoState {
  const ago = (s: number) => clockString(new Date(now.getTime() - s * 1000));
  const newestFirst = [...LOG].sort((a, b) => a.agoSec - b.agoSec);

  return {
    operator: SEED_OPERATOR,
    operatorSince: ago(LOG.find((l) => l.kind === 'session')?.agoSec ?? 0),
    trains: TRAINS.map((t) => ({ ...t, hold: null })),
    alarms: ALARMS.map(({ agoSec, ...a }) => ({ ...a, raisedAt: ago(agoSec), ack: null })),
    restrictions: RESTRICTIONS.map(({ agoSec, ...r }) => {
      const section = SECTIONS.find((s) => s.id === r.sectionId);
      if (!section) throw new Error(`seção desconhecida: ${r.sectionId}`);
      return { ...r, range: section.range, createdAt: ago(agoSec), cleared: null };
    }),
    tsp: TSP.map(({ agoSec, ...t }) => ({ ...t, at: ago(agoSec) })),
    log: newestFirst.map((l, i) => ({
      seq: newestFirst.length - i,
      at: ago(l.agoSec),
      kind: l.kind,
      operator: l.operator,
      text: l.text,
    })),
    nextSeq: newestFirst.length + 1,
    selectedTrain: null,
    simRate: 1,
  };
}

function withLog(state: CcoState, entry: Omit<LogEntry, 'seq'>): CcoState {
  return {
    ...state,
    log: [{ ...entry, seq: state.nextSeq }, ...state.log].slice(0, LOG_CAP),
    nextSeq: state.nextSeq + 1,
  };
}

interface Constraint {
  distance: number;
  position: number;
  reason: HoldReason;
}

/**
 * Restrição mais próxima à frente: ponto de parada antes de uma seção
 * restrita ativa, ou a distância mínima atrás da composição da frente.
 * Usa as posições do instante anterior para todas as composições, o que
 * é conservador — a composição da frente só pode ter avançado.
 */
function nearestConstraint(train: TrainState, state: CcoState): Constraint | null {
  let best: Constraint | null = null;

  for (const r of state.restrictions) {
    if (r.cleared || isInside(train.t, r.range)) continue;
    const holdAt = wrap(r.range[0] - HOLD_MARGIN);
    const distance = forward(train.t, holdAt);
    if (!best || distance < best.distance) {
      best = { distance, position: holdAt, reason: { kind: 'restriction', restrictionId: r.id, sectionId: r.sectionId } };
    }
  }

  for (const other of state.trains) {
    if (other.id === train.id) continue;
    const gap = forward(train.t, other.t) - MIN_GAP;
    const distance = Math.max(0, gap);
    if (!best || distance < best.distance) {
      best = {
        distance,
        position: gap > 0 ? wrap(other.t - MIN_GAP) : train.t,
        reason: { kind: 'train-ahead', trainId: other.id },
      };
    }
  }
  return best;
}

function advanceTrains(state: CcoState, dtSec: number, at: string): CcoState {
  if (dtSec <= 0) return state;
  const step = TRAIN_SPEED * dtSec;
  const events: string[] = [];

  const trains = state.trains.map((train): TrainState => {
    const c = nearestConstraint(train, state);
    const arrives = c !== null && c.distance <= step;

    // Ao chegar ao ponto de restrição, usa a posição exata (nunca t +
    // distância), para que erro de ponto flutuante não faça a composição
    // "pular" o ponto de parada ao dar a volta no loop.
    const t = arrives ? c.position : wrap(train.t + step);
    const hold = arrives && c.distance < step - EPS ? c.reason : null;
    const lostSec = arrives ? dtSec * (1 - c.distance / step) : 0;

    const prev = train.hold;
    if (hold?.kind === 'restriction' && prev?.kind !== 'restriction') {
      events.push(`${train.id} parado antes de ${hold.sectionId} — aguardando liberação de ${hold.restrictionId}`);
    } else if (prev?.kind === 'restriction' && hold?.kind !== 'restriction') {
      events.push(`${train.id} retomou marcha em direção a ${prev.sectionId}`);
    }
    return { ...train, t, dev: train.dev + lostSec, hold };
  });

  let next: CcoState = { ...state, trains };
  for (const text of events) next = withLog(next, { at, kind: 'system', operator: null, text });
  return next;
}

export function ccoReducer(state: CcoState, action: CcoAction): CcoState {
  switch (action.type) {
    case 'TICK':
      return advanceTrains(state, action.dtSec, action.at);

    case 'LOGIN': {
      if (state.operator !== null || !isValidOperatorId(action.operator)) return state;
      const operator = normalizeOperatorId(action.operator);
      return withLog({ ...state, operator, operatorSince: action.at }, { at: action.at, kind: 'session', operator, text: `Operador ${operator} assumiu o posto` });
    }

    case 'LOGOUT': {
      if (state.operator === null) return state;
      const operator = state.operator;
      return withLog({ ...state, operator: null, operatorSince: null }, { at: action.at, kind: 'session', operator, text: `Operador ${operator} deixou o posto` });
    }

    case 'ALARM_ACK': {
      const operator = state.operator;
      const alarm = state.alarms.find((a) => a.id === action.alarmId);
      if (!operator || !alarm || alarm.ack) return state;
      return withLog(
        { ...state, alarms: state.alarms.map((a) => (a === alarm ? { ...a, ack: { by: operator, at: action.at } } : a)) },
        { at: action.at, kind: 'ack', operator, text: `Alarme reconhecido: ${alarm.id}` },
      );
    }

    case 'ALARM_ACTION': {
      const operator = state.operator;
      const alarm = state.alarms.find((a) => a.id === action.alarmId);
      if (!operator || !alarm || !alarm.actions.includes(action.label)) return state;
      return withLog(state, { at: action.at, kind: 'action', operator, text: `${action.label} (${alarm.id})` });
    }

    case 'RESTRICTION_CLEAR': {
      const operator = state.operator;
      const restriction = state.restrictions.find((r) => r.id === action.restrictionId);
      if (!operator || !restriction || restriction.cleared) return state;
      // Confirmação dupla: CFTV verificado e matrícula digitada igual à do
      // operador do posto. Uma restrição nunca é liberada por clique único.
      if (!action.cctvVerified || normalizeOperatorId(action.confirmOperator) !== operator) return state;
      return withLog(
        {
          ...state,
          restrictions: state.restrictions.map((r) =>
            r === restriction ? { ...r, cleared: { by: operator, at: action.at } } : r,
          ),
        },
        { at: action.at, kind: 'clear', operator, text: `Restrição ${restriction.id} liberada em ${restriction.sectionId} (CFTV verificado)` },
      );
    }

    case 'RADIO_CALL': {
      const operator = state.operator;
      if (!operator || !state.trains.some((t) => t.id === action.trainId)) return state;
      return withLog(state, { at: action.at, kind: 'action', operator, text: `Chamada de rádio ao condutor do ${action.trainId}` });
    }

    case 'REGULATION_ADVICE': {
      const operator = state.operator;
      const train = state.trains.find((t) => t.id === action.trainId);
      if (!operator || !train) return state;
      const advice = regulationAdvice(train);
      if (advice.kind !== 'hold') return state;
      return withLog(state, {
        at: action.at,
        kind: 'action',
        operator,
        text: `Aviso de regulação ao ${train.id}: reter ${advice.seconds} s em ${advice.stop}`,
      });
    }

    case 'SELECT_TRAIN':
      if (action.trainId !== null && !state.trains.some((t) => t.id === action.trainId)) return state;
      return { ...state, selectedTrain: action.trainId };

    case 'SET_SIM_RATE':
      return { ...state, simRate: action.rate };
  }
}
