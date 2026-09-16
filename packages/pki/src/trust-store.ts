import { extractCommonName, isExpired, verifyChain } from './ca.js';

/**
 * Trust store operacional: valida certificados de dispositivo contra a cadeia
 * e a lista de revogacao.
 *
 * Substitui o registro de chaves publicas por convenio da Fase 1
 * (services/ingest-gateway/src/registry.ts) numa dimensao especifica: la, uma
 * chave comprometida so parava de ser confiavel se alguem editasse o arquivo e
 * reiniciasse o gateway. Aqui, revogar e imediato e nao exige reiniciar nada -
 * e o requisito minimo para responder a um incidente em producao.
 *
 * O registro de dispositivo (zonas e tipos permitidos) continua sendo
 * responsabilidade do ingest-gateway; este modulo resolve uma pergunta
 * anterior e mais estreita: "este certificado e valido agora?"
 */

export type RevocationReason = 'compromised' | 'superseded' | 'decommissioned' | 'ca_compromise';

export interface RevocationEntry {
  serial: string;
  reason: RevocationReason;
  revokedAt: Date;
}

export class TrustStore {
  readonly #issuingCertPem: string;
  readonly #revoked = new Map<string, RevocationEntry>();

  constructor(issuingCertPem: string) {
    this.#issuingCertPem = issuingCertPem;
  }

  revoke(serial: string, reason: RevocationReason): void {
    this.#revoked.set(serial, { serial, reason, revokedAt: new Date() });
  }

  isRevoked(serial: string): boolean {
    return this.#revoked.has(serial);
  }

  revocationReason(serial: string): RevocationReason | null {
    return this.#revoked.get(serial)?.reason ?? null;
  }

  /**
   * Validacao completa: cadeia de assinatura, validade temporal e revogacao.
   * As tres falham fechado - qualquer uma sozinha nao basta.
   */
  validate(certPem: string, serial: string, expectedCommonName: string): { valid: boolean; reason?: string } {
    if (!verifyChain(certPem, this.#issuingCertPem)) {
      return { valid: false, reason: 'assinatura nao confere com a Issuing CA' };
    }
    if (isExpired(certPem)) {
      return { valid: false, reason: 'certificado expirado ou ainda nao valido' };
    }
    if (this.isRevoked(serial)) {
      return { valid: false, reason: `revogado: ${this.revocationReason(serial)}` };
    }
    const cn = extractCommonName(certPem);
    if (cn !== expectedCommonName) {
      return { valid: false, reason: `CN do certificado (${cn}) nao corresponde ao id esperado (${expectedCommonName})` };
    }
    return { valid: true };
  }

  revokedList(): readonly RevocationEntry[] {
    return [...this.#revoked.values()];
  }
}
