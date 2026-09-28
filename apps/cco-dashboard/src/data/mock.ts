/* ============================================================
 * DADOS MOCKADOS — mesma forma dos tipos reais do sistema
 * (Message<IntrusionData>, OperatorAlarm, TrackRestriction,
 * TspDecision) descritos em docs/PAYLOADS.md, e os mesmos IDs,
 * seções e cenários usados nos testes e bancos de evidência.
 *
 * Horários são deslocamentos (`agoSec`) a partir do carregamento
 * da página, para que o instantâneo seja coerente com o relógio
 * real e com as ações do operador registradas depois.
 * ============================================================ */

export interface Stop {
  id: string;
  name: string;
  /** posição normalizada [0,1) ao longo do loop da Linha 2 */
  t: number;
}

export interface Section {
  id: string;
  from: string;
  to: string;
  range: [number, number];
}

export type TrainColorVar = '--c-blue' | '--c-orange' | '--c-aqua';

export interface TrainSeed {
  id: string;
  colorVar: TrainColorVar;
  t: number;
  /** desvio de tabela horária, em segundos (+atrasado / -adiantado) */
  dev: number;
  occ: string;
}

export type AlarmSeverity = 'critical' | 'major' | 'warning';
export type IntegrityClass = 'basic' | 'sil';

export interface AlarmSeed {
  id: string;
  sev: AlarmSeverity;
  title: string;
  detail: string;
  cls: IntegrityClass;
  conf: string | null;
  model: string | null;
  agoSec: number;
  actions: string[];
}

export interface RestrictionSeed {
  id: string;
  sectionId: string;
  kind: string;
  reason: string;
  cls: IntegrityClass;
  agoSec: number;
}

export type TspAction = 'grant' | 'revoke' | 'denied' | 'idle';

export interface TspSeed {
  crossing: string;
  train: string;
  action: TspAction;
  strategy: string | null;
  reason: string;
  agoSec: number;
}

export interface EdgeNode {
  id: string;
  status: 'ok' | 'off';
  fps: number | null;
  link: 'up' | 'down';
}

export interface LogSeed {
  agoSec: number;
  kind: 'system' | 'session';
  operator: string | null;
  text: string;
}

export const SEED_OPERATOR = 'OP-4471';

export const STOPS: Stop[] = [
  { id: 'C-NEBIAS', name: 'Conselheiro Nébias', t: 0.02 },
  { id: 'ANA-COSTA', name: 'Ana Costa', t: 0.16 },
  { id: 'F-GLICERIO', name: 'Fco. Glicério', t: 0.32 },
  { id: 'CAMPOS-MELLO', name: 'Campos Mello', t: 0.47 },
  { id: 'JOAO-PESSOA', name: 'João Pessoa', t: 0.6 },
  { id: 'AMADOR-BUENO', name: 'Amador Bueno', t: 0.74 },
  { id: 'VALONGO', name: 'Valongo', t: 0.9 },
];

export const SECTIONS: Section[] = STOPS.map((s, i) => {
  const next = STOPS[(i + 1) % STOPS.length];
  return { id: `L2-S${11 + i}`, from: s.name, to: next.name, range: [s.t, next.t] };
});

export const TRAINS: TrainSeed[] = [
  { id: 'VLT-07', colorVar: '--c-blue', t: 0.2, dev: 95, occ: 'em pé' },
  { id: 'VLT-12', colorVar: '--c-orange', t: 0.52, dev: -40, occ: 'poucos lugares' },
  { id: 'VLT-19', colorVar: '--c-aqua', t: 0.81, dev: 12, occ: 'muitos lugares' },
];

export const ALARMS: AlarmSeed[] = [
  {
    id: 'INC-a91f3c',
    sev: 'critical',
    title: 'Invasão de gabarito: automóvel em Conselheiro Nébias – Ana Costa',
    detail:
      'Detecção de automóvel no gabarito dinâmico da seção L2-S11, já 0,35 m dentro do gabarito. Incidente INC-a91f3c.',
    cls: 'basic',
    conf: '94%',
    model: 'railguard-yolo v3.2.1',
    agoSec: 430,
    actions: ['Acionar CFTV do trecho', 'Avisar condutores da L2'],
  },
  {
    id: 'ALM-cobertura-jp01',
    sev: 'major',
    title: 'Cobertura de detecção perdida: edge:jetson:XC-JOÃO-PESSOA-01',
    detail:
      'O nó de borda está offline. A seção coberta por este nó deixou de ter detecção automática de invasão.',
    cls: 'basic',
    conf: null,
    model: null,
    agoSec: 158,
    actions: ['Abrir chamado de manutenção', 'Reforçar vigilância por CFTV'],
  },
];

export const RESTRICTIONS: RestrictionSeed[] = [
  {
    id: 'TSR-08fe2b',
    sectionId: 'L2-S11',
    kind: 'PARADA ACONSELHADA',
    reason:
      'Invasão de gabarito detectada por visão computacional (railguard-yolo v3.2.1, confiança 94%). Incidente INC-a91f3c.',
    cls: 'basic',
    agoSec: 429,
  },
];

export const TSP: TspSeed[] = [
  {
    crossing: 'XC-ANA-COSTA',
    train: 'VLT-07',
    action: 'grant',
    strategy: 'phase_call',
    reason: 'Atraso de 95s, ETA 17s no cruzamento.',
    agoSec: 7,
  },
  {
    crossing: 'XC-JOÃO-PESSOA',
    train: 'VLT-19',
    action: 'grant',
    strategy: 'green_extension',
    reason: 'Fase já verde; extensão de 7s concedida.',
    agoSec: 262,
  },
  {
    crossing: 'XC-CONSTITUIÇÃO',
    train: '*',
    action: 'revoke',
    strategy: null,
    reason: 'Prioridade suspensa: obstrução a jusante na seção L2-S11.',
    agoSec: 428,
  },
  {
    crossing: 'XC-F-GLICÉRIO',
    train: 'VLT-12',
    action: 'denied',
    strategy: 'red_truncation',
    reason: 'Composição adiantada em 40s — prioridade cedida ao trânsito.',
    agoSec: 485,
  },
  {
    crossing: 'XC-CAMPOS-MELLO',
    train: '—',
    action: 'idle',
    strategy: null,
    reason: 'Nenhum pedido nos últimos 5 min.',
    agoSec: 620,
  },
];

export const EDGE_NODES: EdgeNode[] = [
  { id: 'XC-ANA-COSTA-01', status: 'ok', fps: 29.4, link: 'up' },
  { id: 'XC-F-GLICERIO-01', status: 'ok', fps: 30.1, link: 'up' },
  { id: 'XC-CAMPOS-MELLO-01', status: 'ok', fps: 28.7, link: 'up' },
  { id: 'XC-JOAO-PESSOA-01', status: 'off', fps: null, link: 'down' },
  { id: 'XC-CONSTITUICAO-01', status: 'ok', fps: 29.9, link: 'up' },
];

export const LOG: LogSeed[] = [
  { agoSec: 1500, kind: 'session', operator: SEED_OPERATOR, text: `Operador ${SEED_OPERATOR} assumiu o posto` },
  { agoSec: 430, kind: 'system', operator: null, text: 'Invasão de gabarito em L2-S11 — INC-a91f3c (railguard-yolo, 94%)' },
  { agoSec: 429, kind: 'system', operator: null, text: 'Restrição TSR-08fe2b (parada aconselhada) aplicada em L2-S11' },
  { agoSec: 428, kind: 'system', operator: null, text: 'TSP suspenso em XC-CONSTITUIÇÃO: obstrução a jusante' },
  { agoSec: 158, kind: 'system', operator: null, text: 'Nó XC-JOAO-PESSOA-01 offline — cobertura de detecção perdida' },
];
