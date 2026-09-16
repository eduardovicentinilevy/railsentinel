import type { Pool } from 'pg';
import type {
  IntrusionData, Message, OperatorAlarm, TrackRestriction, TrainPositionData, TspDecision,
} from '@railsentinel/contracts';
import type { RejectStage } from './types.js';
import type { SafetyViolation } from './types.js';

/**
 * Historiador: projecao durável do barramento do núcleo.
 *
 * Toda escrita e IDEMPOTENTE via 'ON CONFLICT DO NOTHING' sobre o id do
 * envelope (UUIDv7) quando existe. A razao e a mesma do ReplayGuard na
 * fronteira: MQTT QoS 1 entrega ao menos uma vez, e reentrega e
 * comportamento normal, nao excecao a tratar em cada chamador. O historiador
 * pode reprocessar o mesmo lote de mensagens (reinicio do servico, replay de
 * um topico retido) sem duplicar uma unica linha.
 *
 * Este e o repositorio que uma auditoria de certificacao consulta. A tabela
 * audit_safety_violations vazia em producao normal e, ela propria, a
 * evidencia de que a particao EN 50716 e executavel - nao apenas documentada.
 */
export class Historian {
  constructor(private readonly pool: Pool) {}

  async recordPosition(msg: Message<TrainPositionData>): Promise<void> {
    await this.pool.query(
      `INSERT INTO telemetry_position
         (envelope_id, ts, train_id, run_id, section_id, chainage_m, speed_kmh, schedule_dev_s, occupancy)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (envelope_id) DO NOTHING`,
      [msg.env.id, msg.env.ts, msg.data.train_id, msg.data.run_id ?? null, msg.data.section_id,
       msg.data.chainage_m ?? null, msg.data.speed_kmh, msg.data.schedule_dev_s ?? null, msg.data.occupancy ?? null],
    );
  }

  async recordIntrusion(msg: Message<IntrusionData>, incidentId: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO events_intrusion
         (envelope_id, ts, incident_id, section_id, src, object_class, confidence, gauge_margin_m,
          state, integrity_class, model, model_version, raw_data)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (envelope_id) DO NOTHING`,
      [msg.env.id, msg.env.ts, incidentId, msg.data.track.section_id, msg.env.src,
       msg.data.object.class, msg.data.object.conf, msg.data.track.gauge_margin_m ?? null,
       msg.data.state, msg.env.class, msg.data.detector.model, msg.data.detector.model_version,
       JSON.stringify(msg.data)],
    );
  }

  async recordAlarm(alarm: OperatorAlarm): Promise<void> {
    await this.pool.query(
      `INSERT INTO alarms
         (alarm_id, raised_at, severity, title, detail, section_id, zone, line,
          integrity_class, source, confidence, model, acknowledged)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (alarm_id) DO NOTHING`,
      [alarm.alarm_id, alarm.raised_at, alarm.severity, alarm.title, alarm.detail,
       alarm.section_id ?? null, alarm.zone ?? null, alarm.line ?? null,
       alarm.provenance.integrity_class, alarm.provenance.source, alarm.provenance.confidence ?? null,
       alarm.provenance.model ?? null, alarm.acknowledged],
    );
  }

  /** Reconhecimento de alarme pelo operador - unico UPDATE deste modulo, e auditado por natureza. */
  async acknowledgeAlarm(alarmId: string, operatorId: string, at = new Date()): Promise<void> {
    await this.pool.query(
      `UPDATE alarms SET acknowledged = true, acknowledged_at = $2, acknowledged_by = $3 WHERE alarm_id = $1`,
      [alarmId, at, operatorId],
    );
  }

  async recordRestriction(restriction: TrackRestriction): Promise<void> {
    await this.pool.query(
      `INSERT INTO restrictions
         (restriction_id, section_id, kind, speed_limit_kmh, reason, origin_class,
          issued_at, expires_at, source_event_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (restriction_id) DO NOTHING`,
      [restriction.restriction_id, restriction.section_id, restriction.kind,
       restriction.speed_limit_kmh ?? null, restriction.reason, restriction.origin_class,
       restriction.issued_at, restriction.expires_at, restriction.source_event_id],
    );
  }

  async clearRestriction(sectionId: string, clearedBy: string, at = new Date()): Promise<void> {
    await this.pool.query(
      `UPDATE restrictions SET cleared_at = $2, cleared_by = $3
       WHERE section_id = $1 AND cleared_at IS NULL`,
      [sectionId, at, clearedBy],
    );
  }

  async recordRejection(r: { at: string; stage: RejectStage; detail: string; topic: string; src?: string }): Promise<void> {
    await this.pool.query(
      `INSERT INTO audit_rejected (at, stage, detail, topic, src) VALUES ($1,$2,$3,$4,$5)`,
      [r.at, r.stage, r.detail, r.topic, r.src ?? null],
    );
  }

  async recordSafetyViolation(v: SafetyViolation): Promise<void> {
    await this.pool.query(
      `INSERT INTO audit_safety_violations (at, effect, evidence_class, required_class, source_event_id, rationale)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [v.at, v.effect, v.evidence_class, v.required_class, v.source_event_id, v.rationale],
    );
  }

  async recordTspDecision(d: TspDecision): Promise<void> {
    await this.pool.query(
      `INSERT INTO tsp_decisions (decided_at, crossing_id, train_id, action, ntcip_strategy, reason)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [d.decided_at, d.crossing_id, d.train_id, d.action, d.ntcip_strategy ?? null, d.reason],
    );
  }

  /**
   * Atualiza o pedido de TSP mais recente para o cruzamento com o desfecho
   * REAL devolvido pelo controlador (HIL). O pedido e gravado sem desfecho
   * porque o HIL responde de forma assincrona, em topico separado.
   */
  async updateTspOutcome(crossingId: string, granted: boolean, reason?: string): Promise<void> {
    await this.pool.query(
      `UPDATE tsp_decisions SET granted = $2, grant_reason = $3
       WHERE id = (
         SELECT id FROM tsp_decisions
         WHERE crossing_id = $1 AND granted IS NULL
         ORDER BY decided_at DESC LIMIT 1
       )`,
      [crossingId, granted, reason ?? null],
    );
  }

  /* ---------------------------------------------------------------- */
  /* Consultas de auditoria                                            */
  /* ---------------------------------------------------------------- */

  /**
   * Timeline completa de um incidente: toda deteccao que contribuiu para ele,
   * em ordem. E o que uma investigacao pos-acidente pede primeiro.
   */
  async incidentTimeline(incidentId: string): Promise<Array<Record<string, unknown>>> {
    const r = await this.pool.query(
      `SELECT ts, src, object_class, confidence, gauge_margin_m, state, model, model_version
       FROM events_intrusion WHERE incident_id = $1 ORDER BY ts ASC`,
      [incidentId],
    );
    return r.rows;
  }

  /**
   * Violacoes de particao num intervalo - a consulta que uma auditoria SIL
   * roda primeiro. Vazio e o resultado esperado; qualquer linha e reportavel.
   */
  async safetyViolationsSince(since: Date): Promise<Array<Record<string, unknown>>> {
    const r = await this.pool.query(
      `SELECT * FROM audit_safety_violations WHERE at >= $1 ORDER BY at ASC`,
      [since],
    );
    return r.rows;
  }

  async rejectionsByStage(since: Date): Promise<Array<{ stage: string; count: string }>> {
    const r = await this.pool.query(
      `SELECT stage, count(*) FROM audit_rejected WHERE at >= $1 GROUP BY stage ORDER BY count(*) DESC`,
      [since],
    );
    return r.rows;
  }

  async tspGrantRate(since: Date): Promise<{ total: number; granted: number; rate: number }> {
    const r = await this.pool.query(
      `SELECT count(*) FILTER (WHERE granted IS NOT NULL) AS total,
              count(*) FILTER (WHERE granted = true) AS granted
       FROM tsp_decisions WHERE decided_at >= $1`,
      [since],
    );
    const total = Number(r.rows[0]?.total ?? 0);
    const granted = Number(r.rows[0]?.granted ?? 0);
    return { total, granted, rate: total > 0 ? granted / total : 0 };
  }
}
