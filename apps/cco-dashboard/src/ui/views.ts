import type { IconName } from '../components/Icon';

export type ViewKey = 'geral' | 'linha' | 'alarmes' | 'tsp' | 'borda' | 'registro' | 'passagem';

export interface ViewDef {
  key: ViewKey;
  label: string;
  /** rótulo da barra inferior no celular */
  short: string;
  icon: IconName;
  group: 'Operação' | 'Campo' | 'Turno';
  title: string;
  description: string;
}

/** A ordem também define os atalhos de teclado 1–7. */
export const VIEWS: readonly ViewDef[] = [
  {
    key: 'geral',
    label: 'Visão geral',
    short: 'Geral',
    icon: 'overview',
    group: 'Operação',
    title: 'Visão geral da operação',
    description: 'Situação da Linha 2 agora e o que exige ação primeiro.',
  },
  {
    key: 'linha',
    label: 'Linha 2',
    short: 'Linha',
    icon: 'line',
    group: 'Operação',
    title: 'Linha 2 — Loop Centro Histórico',
    description: 'Posição das composições, desvio de tabela e posto de cada composição.',
  },
  {
    key: 'alarmes',
    label: 'Alarmes e restrições',
    short: 'Alarmes',
    icon: 'alarm',
    group: 'Operação',
    title: 'Alarmes e restrições de via',
    description: 'Reconhecimento de alarmes e liberação de seções em dois passos.',
  },
  {
    key: 'tsp',
    label: 'Prioridade semafórica',
    short: 'TSP',
    icon: 'signal',
    group: 'Campo',
    title: 'Prioridade semafórica · NTCIP 1202',
    description: 'Decisões de prioridade nos cruzamentos da Linha 2.',
  },
  {
    key: 'borda',
    label: 'Nós de borda',
    short: 'Borda',
    icon: 'camera',
    group: 'Campo',
    title: 'Nós de borda · Jetson Orin',
    description: 'Cobertura de detecção por visão computacional nos cruzamentos.',
  },
  {
    key: 'registro',
    label: 'Registro do turno',
    short: 'Registro',
    icon: 'log',
    group: 'Turno',
    title: 'Registro do turno',
    description: 'Todo evento de sistema e todo comando, com operador e horário.',
  },
  {
    key: 'passagem',
    label: 'Passagem de turno',
    short: 'Turno',
    icon: 'handover',
    group: 'Turno',
    title: 'Passagem de turno',
    description: 'Resumo do posto e pendências para quem assume.',
  },
];

export function isViewKey(value: string): value is ViewKey {
  return VIEWS.some((v) => v.key === value);
}

export function viewDef(key: ViewKey): ViewDef {
  return VIEWS.find((v) => v.key === key) ?? VIEWS[0];
}
