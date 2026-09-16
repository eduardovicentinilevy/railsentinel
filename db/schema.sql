-- Historiador RailSentinel - schema PostgreSQL, pronto para hypertable.
--
-- Reproduzir: npm run db:migrate
--
-- Escrito para PostgreSQL puro porque a extensao TimescaleDB nao esta
-- disponivel nesta bancada (exige repositorio apt externo). Cada tabela de
-- serie temporal, porem, segue as duas regras que tornam a migracao para
-- hypertable trivial quando a extensao estiver disponivel:
--
--   1. Uma unica coluna de tempo, sempre chamada 'ts' ou 'at', usada no
--      particionamento (create_hypertable('nome_tabela', 'ts')).
--   2. Append-only: nenhuma tabela de evento tem UPDATE no fluxo normal,
--      so INSERT ... ON CONFLICT DO NOTHING para idempotencia via id do
--      envelope (UUIDv7) - a mesma garantia que o ReplayGuard ja da na
--      fronteira, aqui reaproveitada como chave primaria.
--
-- Upgrade para TimescaleDB (quando disponivel):
--   SELECT create_hypertable('telemetry_position', 'ts');
--   SELECT create_hypertable('events_intrusion', 'ts');
--   (e assim por diante para cada tabela abaixo)
-- Nao muda nenhuma consulta - hypertables sao consultadas com SQL identico.

CREATE TABLE IF NOT EXISTS telemetry_position (
  envelope_id     uuid PRIMARY KEY,
  ts              timestamptz NOT NULL,
  train_id        text NOT NULL,
  run_id          text,
  section_id      text NOT NULL,
  chainage_m      double precision,
  speed_kmh       double precision NOT NULL,
  schedule_dev_s  integer,
  occupancy       text,
  recorded_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_telemetry_position_train_ts ON telemetry_position (train_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_telemetry_position_ts ON telemetry_position (ts DESC);

CREATE TABLE IF NOT EXISTS events_intrusion (
  envelope_id      uuid PRIMARY KEY,
  ts               timestamptz NOT NULL,
  incident_id      text NOT NULL,
  section_id       text NOT NULL,
  src              text NOT NULL,
  object_class     text NOT NULL,
  confidence       double precision NOT NULL,
  gauge_margin_m   double precision,
  state            text NOT NULL,
  integrity_class  text NOT NULL,
  model            text,
  model_version    text,
  raw_data         jsonb NOT NULL,
  recorded_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_events_intrusion_incident ON events_intrusion (incident_id, ts);
CREATE INDEX IF NOT EXISTS idx_events_intrusion_section_ts ON events_intrusion (section_id, ts DESC);

CREATE TABLE IF NOT EXISTS alarms (
  alarm_id      text PRIMARY KEY,
  raised_at     timestamptz NOT NULL,
  severity      text NOT NULL,
  title         text NOT NULL,
  detail        text NOT NULL,
  section_id    text,
  zone          text,
  line          text,
  integrity_class text NOT NULL,
  source        text NOT NULL,
  confidence    double precision,
  model         text,
  acknowledged  boolean NOT NULL DEFAULT false,
  acknowledged_at timestamptz,
  acknowledged_by text,
  recorded_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_alarms_raised_at ON alarms (raised_at DESC);
CREATE INDEX IF NOT EXISTS idx_alarms_section ON alarms (section_id, raised_at DESC);

CREATE TABLE IF NOT EXISTS restrictions (
  restriction_id  text PRIMARY KEY,
  section_id      text NOT NULL,
  kind            text NOT NULL,
  speed_limit_kmh integer,
  reason          text NOT NULL,
  origin_class    text NOT NULL,
  issued_at       timestamptz NOT NULL,
  expires_at      timestamptz NOT NULL,
  source_event_id uuid,
  cleared_at      timestamptz,
  cleared_by      text,
  recorded_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_restrictions_section ON restrictions (section_id, issued_at DESC);

-- Trilha de auditoria: recusas na fronteira IEC 62443. Nao tem chave de
-- envelope porque, por definicao, muitas recusas ocorrem exatamente quando o
-- envelope e ilegivel (JSON malformado, campo obrigatorio ausente).
CREATE TABLE IF NOT EXISTS audit_rejected (
  id          bigserial PRIMARY KEY,
  at          timestamptz NOT NULL,
  stage       text NOT NULL,
  detail      text NOT NULL,
  topic       text NOT NULL,
  src         text,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_rejected_at ON audit_rejected (at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_rejected_stage ON audit_rejected (stage, at DESC);

-- Violacoes de particao EN 50716 barradas pelo SafetyGuard. Esta e a tabela
-- que uma auditoria de certificacao SIL vai consultar primeiro: cada linha e
-- uma tentativa de um efeito exceder a classe de integridade da evidencia que
-- o motivou, e o fato de a tabela existir - e estar vazia em producao normal -
-- e a evidencia de que a particao e executavel, nao so documentada.
CREATE TABLE IF NOT EXISTS audit_safety_violations (
  id                bigserial PRIMARY KEY,
  at                timestamptz NOT NULL,
  effect            text NOT NULL,
  evidence_class    text NOT NULL,
  required_class    text NOT NULL,
  source_event_id   text NOT NULL,
  rationale         text NOT NULL,
  recorded_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_safety_violations_at ON audit_safety_violations (at DESC);

CREATE TABLE IF NOT EXISTS tsp_decisions (
  id             bigserial PRIMARY KEY,
  decided_at     timestamptz NOT NULL,
  crossing_id    text NOT NULL,
  train_id       text NOT NULL,
  action         text NOT NULL,
  ntcip_strategy text,
  reason         text NOT NULL,
  granted        boolean,
  grant_reason   text,
  recorded_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tsp_decisions_crossing_ts ON tsp_decisions (crossing_id, decided_at DESC);
