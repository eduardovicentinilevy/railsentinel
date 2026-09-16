/**
 * Formas estruturais espelhando tipos internos de outros servicos
 * (services/ingest-gateway/src/pipeline.ts, services/ats-core/src/safety-guard.ts).
 *
 * Duplicadas de proposito, nao importadas: o historiador e um PACOTE
 * (dependencia de servico), e um servico nunca deveria depender de outro
 * servico como biblioteca - isso criaria acoplamento de build entre processos
 * que devem poder evoluir e ser implantados independentemente. A duplicacao e
 * pequena e estrutural (duck typing via 'string' em vez do union exato), entao
 * o custo de manutencao e baixo frente ao ganho de isolamento.
 */

export type RejectStage = string;

export interface SafetyViolation {
  at: string;
  effect: string;
  evidence_class: string;
  required_class: string;
  source_event_id: string;
  rationale: string;
}
