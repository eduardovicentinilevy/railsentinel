import type { AlarmSeed, RestrictionSeed, TrainSeed, TspSeed } from '../data/mock.ts';

export type HoldReason =
  | { kind: 'restriction'; restrictionId: string; sectionId: string }
  | { kind: 'train-ahead'; trainId: string };

export interface TrainState extends TrainSeed {
  hold: HoldReason | null;
}

export interface Stamp {
  by: string;
  at: string;
}

export interface AlarmState extends Omit<AlarmSeed, 'agoSec'> {
  raisedAt: string;
  ack: Stamp | null;
}

export interface RestrictionState extends Omit<RestrictionSeed, 'agoSec'> {
  range: [number, number];
  createdAt: string;
  cleared: Stamp | null;
}

export interface TspState extends Omit<TspSeed, 'agoSec'> {
  at: string;
}

export type LogKind = 'system' | 'session' | 'ack' | 'action' | 'clear';

export interface LogEntry {
  seq: number;
  at: string;
  kind: LogKind;
  operator: string | null;
  text: string;
}

export type SimRate = 0 | 1 | 10;

export interface CcoState {
  operator: string | null;
  trains: TrainState[];
  alarms: AlarmState[];
  restrictions: RestrictionState[];
  tsp: TspState[];
  /** mais recente primeiro */
  log: LogEntry[];
  nextSeq: number;
  selectedTrain: string | null;
  simRate: SimRate;
}

export type CcoAction =
  | { type: 'LOGIN'; operator: string; at: string }
  | { type: 'LOGOUT'; at: string }
  | { type: 'TICK'; dtSec: number; at: string }
  | { type: 'ALARM_ACK'; alarmId: string; at: string }
  | { type: 'ALARM_ACTION'; alarmId: string; label: string; at: string }
  | { type: 'RESTRICTION_CLEAR'; restrictionId: string; confirmOperator: string; at: string }
  | { type: 'RADIO_CALL'; trainId: string; at: string }
  | { type: 'SELECT_TRAIN'; trainId: string | null }
  | { type: 'SET_SIM_RATE'; rate: SimRate };
