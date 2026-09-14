import { parseTopic, validateMessage, verifyMessage, ReplayGuard, type Message } from '@railsentinel/contracts';
import type { DeviceRegistry } from './registry.js';

/**
 * Pipeline de admissao do conduite de campo.
 *
 * Ordem das etapas nao e estetica - e orcamento de CPU sob ataque. As checagens
 * mais baratas e mais seletivas vem primeiro, para que uma inundacao de lixo
 * seja descartada antes de tocar Ajv ou criptografia:
 *
 *   1. tamanho        - rejeita por comprimento, sem parse
 *   2. JSON           - parse
 *   3. schema         - envelope, depois payload
 *   4. amarracao      - env.src == segmento do topico == dispositivo conhecido
 *   5. autorizacao    - zona e tipo permitidos para este dispositivo
 *   6. assinatura     - Ed25519 (a etapa cara, por ultimo)
 *   7. frescor        - replay/duplicata
 *
 * Verificar assinatura antes do schema seria o erro classico: gastaria uma
 * verificacao criptografica em cada pacote malformado que chegasse.
 */

export type RejectStage =
  | 'oversize' | 'malformed_json' | 'schema' | 'unknown_topic'
  | 'src_topic_mismatch' | 'unknown_device' | 'revoked_device'
  | 'zone_not_allowed' | 'type_not_allowed' | 'integrity_class_not_allowed'
  | 'missing_signature' | 'bad_signature' | 'replay' | 'rate_limited';

export interface Accepted {
  ok: true;
  message: Message;
  topic: string;
  gaps: number;
  /** A origem reiniciou desde a ultima mensagem: relevante para o painel. */
  rebooted: boolean;
}

export interface Rejected {
  ok: false;
  stage: RejectStage;
  detail: string;
  topic: string;
  /** Presente so quando o parse chegou a produzir algo utilizavel para o log. */
  src?: string;
}

export type Verdict = Accepted | Rejected;

export interface PipelineOptions {
  maxBytes?: number;
  /** Mensagens por segundo por dispositivo. */
  rateLimitPerSec?: number;
  replay?: ReplayGuard;
  /** Fase 1 de bancada pode rodar sem assinatura; producao nunca. */
  requireSignature?: boolean;
}

interface RateState { windowStart: number; count: number }

export class AdmissionPipeline {
  readonly #registry: DeviceRegistry;
  readonly #maxBytes: number;
  readonly #rateLimit: number;
  readonly #replay: ReplayGuard;
  readonly #requireSignature: boolean;
  readonly #rates = new Map<string, RateState>();

  constructor(registry: DeviceRegistry, opts: PipelineOptions = {}) {
    this.#registry = registry;
    this.#maxBytes = opts.maxBytes ?? 8 * 1024;
    this.#rateLimit = opts.rateLimitPerSec ?? 50;
    this.#replay = opts.replay ?? new ReplayGuard();
    this.#requireSignature = opts.requireSignature ?? true;
  }

  admit(topic: string, payload: Buffer, now = Date.now()): Verdict {
    if (payload.byteLength > this.#maxBytes) {
      return { ok: false, stage: 'oversize', detail: `${payload.byteLength}B > ${this.#maxBytes}B`, topic };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(payload.toString('utf8'));
    } catch (e) {
      return { ok: false, stage: 'malformed_json', detail: (e as Error).message, topic };
    }

    const v = validateMessage(parsed);
    if (!v.ok) {
      return { ok: false, stage: 'schema', detail: v.errors.join('; '), topic };
    }
    const msg = parsed as Message;
    const src = msg.env.src;

    const parts = parseTopic(topic);
    if (!parts) {
      return { ok: false, stage: 'unknown_topic', detail: 'topico fora da hierarquia vlt/', topic, src };
    }

    // Amarracao topico <-> identidade. Sem isto um no comprometido poderia
    // publicar eventos se passando por outro cruzamento.
    const srcId = src.split(':')[2];
    if (srcId !== parts.srcId) {
      return { ok: false, stage: 'src_topic_mismatch', detail: `env.src=${srcId} topico=${parts.srcId}`, topic, src };
    }

    const device = this.#registry.bySrc(src);
    if (!device) {
      return { ok: false, stage: 'unknown_device', detail: `${src} nao matriculado`, topic, src };
    }
    if (device.status === 'revoked') {
      return { ok: false, stage: 'revoked_device', detail: `${src} revogado`, topic, src };
    }

    const rate = this.#rates.get(src) ?? { windowStart: now, count: 0 };
    if (now - rate.windowStart >= 1000) {
      rate.windowStart = now;
      rate.count = 0;
    }
    rate.count += 1;
    this.#rates.set(src, rate);
    if (rate.count > this.#rateLimit) {
      return { ok: false, stage: 'rate_limited', detail: `${rate.count}/s > ${this.#rateLimit}/s`, topic, src };
    }

    if (msg.env.zone && !device.allowedZones.includes(msg.env.zone)) {
      return { ok: false, stage: 'zone_not_allowed', detail: `zona ${msg.env.zone} negada para ${src}`, topic, src };
    }
    if (!device.allowedTypes.includes(msg.env.type)) {
      return { ok: false, stage: 'type_not_allowed', detail: `tipo ${msg.env.type} negado para ${src}`, topic, src };
    }

    // Teto de integridade. A classe EN 50716 e autodeclarada pelo dispositivo,
    // entao so vale alguma coisa se a fronteira a conferir contra a homologacao
    // registrada. Um no que reivindica classe acima do seu teto e recusado, e a
    // tentativa vai para auditoria - reivindicacao de classe indevida e
    // indicador de comprometimento, nao erro de configuracao.
    const RANK = { basic: 0, sil2: 1, sil4: 2 } as const;
    if (RANK[msg.env.class] > RANK[device.maxIntegrityClass]) {
      return {
        ok: false, stage: 'integrity_class_not_allowed',
        detail: `${src} reivindicou '${msg.env.class}' mas esta homologado ate '${device.maxIntegrityClass}'`,
        topic, src,
      };
    }

    if (this.#requireSignature) {
      if (!msg.sig) {
        return { ok: false, stage: 'missing_signature', detail: 'sig ausente', topic, src };
      }
      const signer = this.#registry.byKid(msg.sig.kid);
      if (!signer || signer.src !== src) {
        return { ok: false, stage: 'bad_signature', detail: `kid ${msg.sig.kid} nao pertence a ${src}`, topic, src };
      }
      if (!verifyMessage(msg, signer.publicKeyPem)) {
        return { ok: false, stage: 'bad_signature', detail: 'Ed25519 nao confere', topic, src };
      }
    }

    const gaps = this.#replay.gapCount(src, msg.env.seq, msg.env.boot);
    const fresh = this.#replay.check(
      { src, id: msg.env.id, seq: msg.env.seq, boot: msg.env.boot, ts: msg.env.ts },
      now,
    );
    if (!fresh.accept) {
      return { ok: false, stage: 'replay', detail: `${fresh.reason}: ${fresh.detail}`, topic, src };
    }

    return { ok: true, message: msg, topic, gaps, rebooted: Boolean(fresh.rebooted) };
  }
}
