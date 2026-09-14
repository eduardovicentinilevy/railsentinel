/**
 * Tipos do contrato de mensageria RailSentinel.
 * Fonte da verdade: /schemas/*.json. Estes tipos sao o espelho TypeScript.
 */

/** CENELEC EN 50716 - classe de integridade da origem da mensagem. */
export type IntegrityClass = 'basic' | 'sil2' | 'sil4';

export type Severity = 'info' | 'warning' | 'major' | 'critical';

export interface Envelope {
  /** Versao do envelope. */
  v: 1;
  /** UUIDv7 - ordenavel por tempo, usado como chave de idempotencia. */
  id: string;
  /** Contador monotonico dentro da sessao de boot: detecta lacuna e replay. */
  seq: number;
  /**
   * Sessao de boot do dispositivo (epoch ms na inicializacao).
   * Equivalente ao bdSeq do Sparkplug B: permite distinguir reinicio legitimo
   * (seq zera, boot avanca) de replay (seq regride, boot igual ou anterior).
   */
  boot: number;
  /** Relogio da origem (RFC3339 UTC, ms). */
  ts: string;
  /** kind:platform:ID - deve casar com o CN do certificado mTLS. */
  src: string;
  site: 'santos';
  line?: 'L1' | 'L2' | 'L3';
  zone?: string;
  /** vlt.<dominio>.<nome>.v<N> */
  type: string;
  /**
   * Particao EN 50716 carregada in-band.
   * 'basic' = Integridade Basica (IA / visao computacional). O SafetyGuard do
   * ats-core recusa qualquer tentativa de usar isto como entrada vital.
   */
  class: IntegrityClass;
  sev: Severity;
  /** Correlaciona evento -> decisao -> comando ao longo de toda a cadeia. */
  corr?: string;
}

export interface Signature {
  alg: 'Ed25519';
  kid: string;
  /** base64url da assinatura sobre canonicalize({env,data}). */
  val: string;
}

export interface Message<T = Record<string, unknown>> {
  env: Envelope;
  data: T;
  sig?: Signature;
}

/* ------------------------------------------------------------------ */
/* Payloads tipados                                                     */
/* ------------------------------------------------------------------ */

export type IntrusionEvent = 'gauge_intrusion' | 'foreign_object' | 'track_defect' | 'crowd_density';
export type IntrusionState = 'onset' | 'sustained' | 'cleared';
export type ObjectClass = 'car' | 'truck' | 'motorcycle' | 'bicycle' | 'person' | 'animal' | 'debris' | 'unknown';

export interface IntrusionData {
  event: IntrusionEvent;
  state: IntrusionState;
  object: {
    class: ObjectClass;
    conf: number;
    track_id?: string;
    bbox_norm?: [number, number, number, number];
    count?: number;
  };
  geo?: { lat: number; lon: number; accuracy_m?: number };
  track: {
    section_id: string;
    chainage_m?: number;
    /** Negativo = objeto ja dentro do gabarito dinamico. */
    gauge_margin_m?: number;
    direction?: 'up' | 'down' | 'both';
  };
  detector: {
    model: string;
    model_version: string;
    infer_ms: number;
    frame_ts?: string;
    pipeline?: string;
  };
  evidence?: { ref?: string; ttl_s?: number; retrieval?: 'pull'; redacted?: boolean };
  dwell_ms?: number;
}

export interface HealthData {
  status: 'ok' | 'degraded' | 'fault' | 'offline';
  uptime_s?: number;
  cpu_pct?: number;
  gpu_temp_c?: number;
  fps?: number;
  last_infer_age_ms?: number;
  camera_link?: 'up' | 'down' | 'flapping';
  model_loaded?: boolean;
  reason?: string;
}

export interface TrainPositionData {
  train_id: string;
  run_id?: string;
  section_id: string;
  chainage_m?: number;
  speed_kmh: number;
  heading_deg?: number;
  next_stop_id?: string;
  /** Negativo = adiantado; positivo = atrasado. */
  schedule_dev_s?: number;
  doors?: 'closed' | 'opening' | 'open' | 'closing';
  occupancy?: 'empty' | 'many_seats' | 'few_seats' | 'standing_room' | 'crushed' | 'full';
  traction_temp_c?: number;
  battery_soc_pct?: number;
}

/* ------------------------------------------------------------------ */
/* Eventos internos do barramento do nucleo (Zona de Integracao)        */
/* ------------------------------------------------------------------ */

export interface TrackRestriction {
  restriction_id: string;
  section_id: string;
  /** advisory = sem autoridade de frenagem. Unico nivel que Integridade Basica pode emitir. */
  kind: 'advisory_speed_limit' | 'advisory_hold';
  speed_limit_kmh?: number;
  reason: string;
  /** Proveniencia: qual classe de integridade originou a restricao. */
  origin_class: IntegrityClass;
  issued_at: string;
  expires_at: string;
  /** Restricao so sai com acao humana - nunca por expiracao silenciosa. */
  requires_operator_ack: true;
  source_event_id: string;
}

export interface OperatorAlarm {
  alarm_id: string;
  severity: Severity;
  title: string;
  detail: string;
  section_id?: string;
  zone?: string;
  line?: string;
  raised_at: string;
  acknowledged: boolean;
  /** Rotulo visivel na IHM para o operador saber o peso probatorio do alerta. */
  provenance: { integrity_class: IntegrityClass; source: string; confidence?: number; model?: string };
  evidence_ref?: string;
  actions: string[];
}

export interface TspDecision {
  crossing_id: string;
  train_id: string;
  /** grant = pedir prioridade; revoke = retirar pedido (acao inerentemente fail-safe). */
  action: 'request_grant' | 'revoke';
  ntcip_strategy?: 'phase_call' | 'green_extension' | 'red_truncation';
  reason: string;
  decided_at: string;
}
