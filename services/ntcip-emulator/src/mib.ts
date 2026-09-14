/**
 * Mapeamento OID <-> objetos NTCIP 1202.
 *
 * A arvore real e 1.3.6.1.4.1.1206.4.2.1 (NEMA/ITE, ramo 'transportation').
 * Os OIDs abaixo seguem essa estrutura para os objetos que o TSP toca. Um
 * controlador real expoe centenas; reproduzir os relevantes com os OIDs certos
 * e o que permite trocar o emulador pelo equipamento da CET-Santos sem mexer no
 * cliente SNMP.
 */

export const BASE = '1.3.6.1.4.1.1206.4.2.1';

export const OID = {
  // phase (1.3.6.1.4.1.1206.4.2.1.1)
  phaseNumber:        `${BASE}.1.2.1.1`,
  phaseMinimumGreen:  `${BASE}.1.2.1.4`,
  phaseYellowChange:  `${BASE}.1.2.1.8`,
  phaseRedClear:      `${BASE}.1.2.1.9`,
  phaseMaximumGreen:  `${BASE}.1.2.1.6`,
  // phaseControl - escrita de comandos de fase
  phaseControlGroupPhaseCall:    `${BASE}.1.5.1.3`,
  phaseControlGroupForceOff:     `${BASE}.1.5.1.5`,
  // phaseStatus - leitura de estado (realimentacao para o ATS)
  phaseStatusGroupGreens:        `${BASE}.1.4.1.4`,
  phaseStatusGroupYellows:       `${BASE}.1.4.1.5`,
  phaseStatusGroupReds:          `${BASE}.1.4.1.6`,
  // priority (1.3.6.1.4.1.1206.4.2.1.20) - Priority Request Server
  priorityRequestPhase:          `${BASE}.20.2.1.3`,
  priorityRequestVehicleClass:   `${BASE}.20.2.1.4`,
  priorityRequestStrategyNumber: `${BASE}.20.2.1.5`,
  priorityRequestID:             `${BASE}.20.2.1.2`,
  priorityRequestServerStatus:   `${BASE}.20.1.3`,
  // Extensao local: resultado do ultimo pedido, para realimentacao no HIL.
  prsLastGrantResult:            `${BASE}.20.1.90`,
  prsSecondsUntilGreen:          `${BASE}.20.1.91`,
  prsActivePhase:                `${BASE}.20.1.92`,
  prsActiveColor:                `${BASE}.20.1.93`,
} as const;

/** Nome legivel do objeto usado pelo ats-core, para o OID correspondente. */
export const NAME_TO_OID: Record<string, string> = {
  'phaseControl.phaseCall': OID.phaseControlGroupPhaseCall,
  'phaseTable.phaseForceOff': OID.phaseControlGroupForceOff,
  'phaseTable.phaseMaxGreenExtension': OID.phaseMaximumGreen,
  'priorityRequest.priorityRequestPhase': OID.priorityRequestPhase,
  'priorityRequest.priorityRequestVehicleClass': OID.priorityRequestVehicleClass,
  'priorityRequest.priorityRequestStrategyNumber': OID.priorityRequestStrategyNumber,
  'priorityRequest.priorityRequestID': OID.priorityRequestID,
  'priorityRequestServer.prsControlPlan': OID.priorityRequestServerStatus,
};

export const COLOR_CODE = { green: 1, yellow: 2, all_red: 3 } as const;
