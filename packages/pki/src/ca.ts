import forge from 'node-forge';
import { randomBytes } from 'node:crypto';

/**
 * Autoridade Certificadora interna do RailSentinel.
 *
 * A Fase 1 autenticava dispositivos por conveniencia de chave (Ed25519
 * conhecido, distribuido fora de banda). Isso e suficiente para provar o
 * CONTRATO de mensageria, mas nao sustenta o que a IEC 62443 exige em campo:
 * identidade com validade limitada, revogacao, e uma cadeia de confianca que
 * um auditor possa inspecionar sem reimplantar cada dispositivo manualmente.
 *
 * O desenho segue o padrao ferroviario/industrial de duas camadas:
 *
 *   Root CA (offline, vida longa, ~10 anos)
 *     └─ Issuing CA (online, assina folhas, ~2 anos)
 *          └─ certificados de dispositivo (vida curta, 30 dias, ECDSA P-256)
 *
 * A Root fica OFFLINE por design - a chave privada dela nunca toca um processo
 * conectado a rede. Comprometer a Issuing CA (que precisa estar online para
 * emitir certificados sob demanda) permite revogar e reemitir; comprometer a
 * Root exigiria reconstruir a confianca de toda a frota. Separar as duas
 * camadas e o que torna esse pior cenario administravel em vez de fatal.
 *
 * ECDSA P-256 em vez de RSA: assinatura e verificacao em microssegundos no
 * Jetson Orin, chave e certificado bem menores no canal MQTT, e e o que a
 * industria automotiva/ferroviaria ja usa em V2X e telemetria embarcada.
 */

export interface KeyPairPem {
  publicKeyPem: string;
  privateKeyPem: string;
}

export interface CertBundle {
  certPem: string;
  keyPem: string;
  /** Serial em hexadecimal - chave primaria para revogacao. */
  serial: string;
  notBefore: Date;
  notAfter: Date;
}

/**
 * RSA-2048, nao ECDSA P-256 - decisao deliberada, nao lacuna.
 *
 * node-forge codifica certificados X.509 completos (SubjectPublicKeyInfo,
 * assinatura, extensoes) apenas para chaves RSA; sua API de alto nivel rejeita
 * chaves EC com "Unknown OID" ao tentar parsear a SPKI. A alternativa seria
 * montar a estrutura ASN.1 do certificado EC a mao com forge.asn1 - exatamente
 * o tipo de codigo criptografico onde um OID trocado ou um encoding de
 * assinatura incorreto passa nos PROPRIOS testes (que usam o mesmo codigo para
 * verificar) e falha silenciosamente contra qualquer verificador X.509 real
 * (OpenSSL, um broker EMQX, um navegador). Isso e inaceitavel numa peca de
 * confianca do sistema.
 *
 * RSA-2048 e o caminho que node-forge suporta de ponta a ponta e que produz
 * certificados verificaveis por ferramentas padrao - confirmado aqui com
 * 'openssl verify', nao apenas com verifyChain() deste pacote. O custo e
 * certificados maiores e assinatura mais lenta que EC; irrelevante na cadencia
 * de matricula (uma vez por dispositivo, nao por mensagem) e nao aplicavel a
 * assinatura por mensagem, que continua sendo Ed25519 nativo do Node
 * (packages/contracts/src/crypto.ts).
 *
 * Migrar a CA para ECDSA P-256 em producao e trabalho de ferramenta dedicada
 * (step-ca, cfssl ou scripts OpenSSL), nao de reimplementar ASN.1 X.509 em
 * TypeScript.
 */
export function generateP256KeyPair(): KeyPairPem {
  const keys = forge.pki.rsa.generateKeyPair({ bits: 2048 });
  return { publicKeyPem: forge.pki.publicKeyToPem(keys.publicKey), privateKeyPem: forge.pki.privateKeyToPem(keys.privateKey) };
}

interface IssueOptions {
  commonName: string;
  /** Dias de validade. Curto para folhas (dispositivos), longo para CAs. */
  validityDays: number;
  isCA?: boolean;
  /**
   * 'client' (padrao) = dispositivo autenticando-se perante o broker.
   * 'server' = identidade do PROPRIO broker/servico, para TLS do lado servidor.
   * Um certificado com EKU clientAuth e recusado por qualquer cliente TLS
   * correto ao ser apresentado como certificado de SERVIDOR - "unsuitable
   * certificate purpose". Sao papeis distintos mesmo quando o mesmo processo
   * (o ingest-gateway) os desempenha em conexoes diferentes.
   */
  role?: 'client' | 'server';
  /** SANs (dNSName/iPAddress) - exigidos por clientes TLS modernos para o certificado de servidor. */
  subjectAltNames?: string[];
  subjectPublicKeyPem: string;
  issuerPrivateKeyPem: string;
  issuerCertPem?: string; // ausente = autoassinado (Root)
  serial?: string;
}

function randomSerialHex(): string {
  // Bit alto zerado: alguns parsers ASN.1 tratam serial com MSB setado como
  // negativo se nao houver byte de padding - zerar evita ambiguidade.
  const b = randomBytes(16);
  b[0]! &= 0x7f;
  return b.toString('hex');
}

/** Emite um certificado X.509 v3 assinado pela CA fornecida (ou autoassinado). */
export function issueCertificate(opts: IssueOptions): CertBundle {
  const cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.publicKeyFromPem(opts.subjectPublicKeyPem);
  cert.serialNumber = opts.serial ?? randomSerialHex();

  const now = new Date();
  cert.validity.notBefore = now;
  cert.validity.notAfter = new Date(now.getTime() + opts.validityDays * 86_400_000);

  const subjectAttrs = [{ name: 'commonName', value: opts.commonName }, { name: 'organizationName', value: 'RailSentinel VLT-BS' }];
  cert.setSubject(subjectAttrs);

  const issuerPrivateKey = forge.pki.privateKeyFromPem(opts.issuerPrivateKeyPem);
  const issuerCert = opts.issuerCertPem ? forge.pki.certificateFromPem(opts.issuerCertPem) : null;
  cert.setIssuer(issuerCert ? issuerCert.subject.attributes : subjectAttrs);

  // Os tipos publicados de node-forge (@types/node-forge) nao cobrem os campos
  // reais de extensao X.509 que a biblioteca aceita em runtime (cA, keyCertSign,
  // clientAuth etc. sao suportados pelo forge, so nao declarados). 'any' aqui e
  // a fronteira exata onde o typing de terceiros esta errado, nao uma fuga de
  // tipagem no nosso codigo.
  const extensions: any[] = [
    { name: 'basicConstraints', cA: Boolean(opts.isCA), critical: true },
    opts.isCA
      ? { name: 'keyUsage', keyCertSign: true, cRLSign: true, digitalSignature: true, critical: true }
      : { name: 'keyUsage', digitalSignature: true, keyEncipherment: false, critical: true },
  ];
  if (!opts.isCA) {
    const role = opts.role ?? 'client';
    extensions.push({ name: 'extKeyUsage', clientAuth: role === 'client', serverAuth: role === 'server' });
    if (opts.subjectAltNames?.length) {
      extensions.push({
        name: 'subjectAltName',
        altNames: opts.subjectAltNames.map((name) => (
          /^\d+\.\d+\.\d+\.\d+$/.test(name) ? { type: 7, ip: name } : { type: 2, value: name }
        )),
      });
    }
  }
  cert.setExtensions(extensions);

  cert.sign(issuerPrivateKey, forge.md.sha256.create());

  return {
    certPem: forge.pki.certificateToPem(cert),
    keyPem: '', // a chave privada da folha e do proprio dispositivo, nunca passa por aqui
    serial: cert.serialNumber,
    notBefore: cert.validity.notBefore,
    notAfter: cert.validity.notAfter,
  };
}

export function verifyChain(leafPem: string, issuerPem: string): boolean {
  try {
    const leaf = forge.pki.certificateFromPem(leafPem);
    const issuer = forge.pki.certificateFromPem(issuerPem);
    return issuer.verify(leaf);
  } catch {
    return false;
  }
}

export function extractCommonName(certPem: string): string | null {
  try {
    const cert = forge.pki.certificateFromPem(certPem);
    // forge.getField(str) resolve por SHORTNAME ('CN'), nao pelo nome longo
    // ('commonName') apesar do atributo carregar ambos - passar 'commonName'
    // aqui sempre retorna null e faz todo certificado parecer sem CN.
    const cn = cert.subject.getField('CN');
    return cn ? String(cn.value) : null;
  } catch {
    return null;
  }
}

export function isExpired(certPem: string, now = new Date()): boolean {
  const cert = forge.pki.certificateFromPem(certPem);
  return now < cert.validity.notBefore || now > cert.validity.notAfter;
}
