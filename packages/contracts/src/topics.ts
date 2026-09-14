/**
 * Hierarquia de topicos MQTT.
 *
 * O desenho do topico E o modelo de autorizacao. Sob IEC 62443 cada no de borda
 * recebe uma ACL que so permite publicar em vlt/+/+/+/edge/<seu-proprio-id>/#.
 * Como env.src precisa casar com o CN do certificado e o CN precisa casar com o
 * segmento do topico, um no comprometido nao consegue falsificar eventos de
 * outro cruzamento - a fraude fica contida ao proprio no.
 *
 *   vlt/{site}/{line}/{zone}/{srcKind}/{srcId}/{stream}[/{name}]
 *
 * stream:  tlm = telemetria periodica | evt = evento discreto
 *          hb  = heartbeat/LWT        | cmd = comando descendente
 */

export interface TopicParts {
  site: string;
  line: string;
  zone: string;
  srcKind: 'edge' | 'train' | 'plc' | 'rtu' | 'tsc';
  srcId: string;
  stream: 'tlm' | 'evt' | 'hb' | 'cmd';
  name?: string;
}

export function buildTopic(p: TopicParts): string {
  const base = `vlt/${p.site}/${p.line}/${p.zone}/${p.srcKind}/${p.srcId}/${p.stream}`;
  return p.name ? `${base}/${p.name}` : base;
}

export function parseTopic(topic: string): TopicParts | null {
  const s = topic.split('/');
  if (s.length < 7 || s[0] !== 'vlt') return null;
  const [, site, line, zone, srcKind, srcId, stream, name] = s;
  if (!site || !line || !zone || !srcKind || !srcId || !stream) return null;
  return { site, line, zone, srcKind: srcKind as TopicParts['srcKind'], srcId, stream: stream as TopicParts['stream'], ...(name ? { name } : {}) };
}

/** ACL que o broker de campo aplica por dispositivo (publicacao). */
export function publishAclFor(srcId: string): string {
  return `vlt/+/+/+/+/${srcId}/#`;
}

/** ACL de assinatura: o dispositivo so ouve comandos enderecados a ele. */
export function subscribeAclFor(srcId: string): string {
  return `vlt/+/+/+/+/${srcId}/cmd/#`;
}

/** Assinaturas do ingest-gateway no broker de CAMPO (zona periferica). */
export const FIELD_SUBSCRIPTIONS = ['vlt/+/+/+/edge/+/evt/#', 'vlt/+/+/+/edge/+/hb', 'vlt/+/+/+/train/+/tlm/#'] as const;

/**
 * Topicos do barramento do NUCLEO (Zona de Integracao Operacional).
 * Broker fisicamente distinto do de campo - o gateway e o unico processo
 * autorizado a existir nos dois lados. Esse e o conduite da IEC 62443.
 */
export const CORE = {
  normalizedIntrusion: 'core/evt/intrusion',
  normalizedHealth: 'core/evt/edge_health',
  normalizedPosition: 'core/tlm/train_position',
  trackRestriction: 'core/evt/track_restriction',
  operatorAlarm: 'core/evt/operator_alarm',
  tspDecision: 'core/evt/tsp_decision',
  systemState: 'core/sta/system',
  auditRejected: 'core/audit/rejected',
  safetyViolation: 'core/audit/safety_violation',
} as const;
