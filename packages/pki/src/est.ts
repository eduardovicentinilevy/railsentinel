import { randomBytes } from 'node:crypto';
import { generateP256KeyPair, issueCertificate, type CertBundle, type KeyPairPem } from './ca.js';

/**
 * Matricula EST simplificada (RFC 7030) para dispositivos de campo.
 *
 * A RFC completa cobre TLS mutuo, autenticacao HTTP e reemissao automatica;
 * aqui reduzimos ao nucleo que muda o modelo de confianca frente a Fase 1: o
 * dispositivo nunca gera a chave privada FORA de si mesmo, e a CSR e o unico
 * artefato que atravessa a rede antes de existir confianca.
 *
 * Fluxo:
 *
 *   1. Fabrica/instalacao grava um TOKEN DE MATRICULA de uso unico no
 *      dispositivo (fora de banda - nao trafega por MQTT).
 *   2. O dispositivo gera seu proprio par de chaves ECDSA P-256. A privada
 *      NUNCA sai do processo que a gerou - em campo, do Secure Element do
 *      Jetson Orin.
 *   3. O dispositivo monta uma CSR (Certificate Signing Request) com o token
 *      e o CommonName que reivindica, e envia so a CSR e o token para a
 *      Issuing CA.
 *   4. A CA verifica o token (existe, nao foi usado, corresponde ao id
 *      reivindicado), emite um certificado de vida curta e o devolve.
 *   5. O token e queimado - reuso e a assinatura mais clara de que o token
 *      vazou.
 *
 * O ponto de desenho que sustenta tudo isto: um comprometimento do CANAL de
 * matricula (alguem intercepta a resposta da CA) expoe um certificado PUBLICO
 * - inofensivo por definicao. Um comprometimento teria que alcancar a chave
 * privada dentro do proprio dispositivo, que e exatamente o que o Secure
 * Element torna caro.
 */

export interface EnrollmentToken {
  token: string;
  /** Id de dispositivo ao qual este token esta amarrado - a CA nao emite CN diferente. */
  deviceId: string;
  expiresAt: Date;
  used: boolean;
}

export interface Csr {
  deviceId: string;
  token: string;
  publicKeyPem: string;
}

export interface EnrollmentResult {
  certBundle: CertBundle;
  keyPair: KeyPairPem;
}

export class TokenStore {
  readonly #tokens = new Map<string, EnrollmentToken>();

  issueToken(deviceId: string, ttlMinutes = 60): string {
    const token = randomToken();
    this.#tokens.set(token, { token, deviceId, expiresAt: new Date(Date.now() + ttlMinutes * 60_000), used: false });
    return token;
  }

  /** Consome o token. Retorna null se invalido, expirado ou ja usado - nunca reutilizavel. */
  redeem(token: string, claimedDeviceId: string, now = new Date()): EnrollmentToken | null {
    const t = this.#tokens.get(token);
    if (!t || t.used || now > t.expiresAt || t.deviceId !== claimedDeviceId) return null;
    t.used = true;
    return t;
  }

  revoke(token: string): void {
    this.#tokens.delete(token);
  }
}

/** CSPRNG do SO via OpenSSL - nunca Math.random. Token previsivel destroi a garantia de uso unico. */
function randomToken(): string {
  return randomBytes(24).toString('base64url');
}

/**
 * Autoridade de matricula: mantem a Issuing CA e os tokens pendentes.
 * A Root fica fora desta classe de proposito - ela so assina a Issuing CA uma
 * vez, na inicializacao da PKI, e depois nunca mais e tocada.
 */
export class EnrollmentAuthority {
  readonly #issuingCaKeyPem: string;
  readonly #issuingCaCertPem: string;
  readonly #tokens = new TokenStore();
  readonly #leafValidityDays: number;

  constructor(issuingCaKeyPem: string, issuingCaCertPem: string, leafValidityDays = 30) {
    this.#issuingCaKeyPem = issuingCaKeyPem;
    this.#issuingCaCertPem = issuingCaCertPem;
    this.#leafValidityDays = leafValidityDays;
  }

  issueToken(deviceId: string, ttlMinutes?: number): string {
    return this.#tokens.issueToken(deviceId, ttlMinutes);
  }

  /**
   * Processa uma CSR. A chave publica veio do dispositivo; a privada nunca
   * trafegou. Retorna o certificado ou null se o token nao validar.
   */
  enroll(csr: Csr): CertBundle | null {
    const redeemed = this.#tokens.redeem(csr.token, csr.deviceId);
    if (!redeemed) return null;

    return issueCertificate({
      commonName: csr.deviceId,
      validityDays: this.#leafValidityDays,
      subjectPublicKeyPem: csr.publicKeyPem,
      issuerPrivateKeyPem: this.#issuingCaKeyPem,
      issuerCertPem: this.#issuingCaCertPem,
    });
  }

  get issuingCertPem(): string {
    return this.#issuingCaCertPem;
  }
}

/**
 * Simula o lado do DISPOSITIVO: gera a chave localmente e conduz a matricula.
 * Em campo isto roda dentro do Secure Element do Jetson; aqui, no processo do
 * simulador - a API e identica, so muda onde a chave privada mora fisicamente.
 */
export function enrollDevice(authority: EnrollmentAuthority, deviceId: string, token: string): EnrollmentResult | null {
  const keyPair = generateP256KeyPair();
  const cert = authority.enroll({ deviceId, token, publicKeyPem: keyPair.publicKeyPem });
  if (!cert) return null;
  return { certBundle: cert, keyPair };
}
