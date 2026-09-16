/**
 * Bootstrap da PKI interna: Root CA -> Issuing CA -> certificados de dispositivo.
 *
 * Substitui, para o transporte, a convencao de chave da Fase 1
 * (.secrets/devices.json com chaves Ed25519 conhecidas por acordo previo) por
 * identidade X.509 revogavel. As duas coisas continuam coexistindo de
 * proposito: X.509 autentica o SALTO ate o broker (mTLS); Ed25519 no envelope
 * continua autenticando a MENSAGEM fim-a-fim atraves do broker e do conduite.
 * Comprometer o broker nao basta para forjar uma mensagem; revogar um
 * certificado nao exige reemitir a chave de assinatura de mensagem.
 *
 * A Root fica em .secrets/pki/root-key.pem apenas porque esta e uma bancada.
 * Em campo a chave da Root NUNCA toca disco de um processo conectado a rede -
 * ela e gerada e usada uma unica vez, num ambiente air-gapped, para assinar a
 * Issuing CA, e depois arquivada offline (HSM ou cofre fisico).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import {
  generateP256KeyPair, issueCertificate, EnrollmentAuthority, enrollDevice,
} from '@railsentinel/pki';

const PKI_DIR = '.secrets/pki';
const ROOT_VALIDITY_DAYS = 3650;   // 10 anos - assina uma unica vez, depois fica offline
const ISSUING_VALIDITY_DAYS = 730; // 2 anos - renovada por procedimento manual auditado
const LEAF_VALIDITY_DAYS = 30;     // 30 dias - forca rotacao frequente, reduz janela de uma chave vazada

interface DeviceToEnroll {
  id: string;
}

const DEVICES: DeviceToEnroll[] = [
  { id: 'edge:jetson:XC-ANA-COSTA-01' },
  { id: 'edge:jetson:XC-F-GLICERIO-01' },
  { id: 'edge:jetson:XC-CAMPOS-MELLO-01' },
  { id: 'edge:jetson:XC-JOAO-PESSOA-01' },
  { id: 'edge:jetson:XC-CONSTITUICAO-01' },
  { id: 'train:tramlink:FLEET-GW' },
  // O gateway tambem e um dispositivo na rede de campo do ponto de vista do
  // broker mTLS: ele PRECISA de identidade propria para se conectar, mesmo
  // sendo o unico processo autorizado a tambem falar com o nucleo.
  { id: 'gw:core:INGEST-GATEWAY' },
];

function main(): void {
  mkdirSync(PKI_DIR, { recursive: true });

  console.log('Emitindo Root CA (10 anos - assina uma vez, depois fica offline)...');
  const root = generateP256KeyPair();
  const rootCert = issueCertificate({
    commonName: 'RailSentinel Root CA', validityDays: ROOT_VALIDITY_DAYS, isCA: true,
    subjectPublicKeyPem: root.publicKeyPem, issuerPrivateKeyPem: root.privateKeyPem,
  });
  writeFileSync(`${PKI_DIR}/root-cert.pem`, rootCert.certPem);
  writeFileSync(`${PKI_DIR}/root-key.pem`, root.privateKeyPem);

  console.log('Emitindo Issuing CA (2 anos - fica online para matricular dispositivos)...');
  const issuing = generateP256KeyPair();
  const issuingCert = issueCertificate({
    commonName: 'RailSentinel Issuing CA', validityDays: ISSUING_VALIDITY_DAYS, isCA: true,
    subjectPublicKeyPem: issuing.publicKeyPem, issuerPrivateKeyPem: root.privateKeyPem, issuerCertPem: rootCert.certPem,
  });
  writeFileSync(`${PKI_DIR}/issuing-cert.pem`, issuingCert.certPem);
  writeFileSync(`${PKI_DIR}/issuing-key.pem`, issuing.privateKeyPem);
  // Cadeia completa (issuing + root) - o que um verificador TLS tipicamente
  // quer para reconstruir o caminho de confianca sem outra fonte.
  writeFileSync(`${PKI_DIR}/chain.pem`, `${issuingCert.certPem}\n${rootCert.certPem}`);

  console.log('Emitindo certificado de SERVIDOR do broker de campo (EKU serverAuth)...');
  const brokerKey = generateP256KeyPair();
  const brokerCert = issueCertificate({
    commonName: 'railsentinel-field-broker', validityDays: LEAF_VALIDITY_DAYS, role: 'server',
    subjectAltNames: ['localhost', '127.0.0.1'],
    subjectPublicKeyPem: brokerKey.publicKeyPem, issuerPrivateKeyPem: issuing.privateKeyPem, issuerCertPem: issuingCert.certPem,
  });
  writeFileSync(`${PKI_DIR}/field-broker.crt.pem`, brokerCert.certPem);
  writeFileSync(`${PKI_DIR}/field-broker.key.pem`, brokerKey.privateKeyPem);

  const authority = new EnrollmentAuthority(issuing.privateKeyPem, issuingCert.certPem, LEAF_VALIDITY_DAYS);

  console.log(`Matriculando ${DEVICES.length} dispositivos via EST simplificado...`);
  const enrolled: Array<{ id: string; serial: string; certPath: string; keyPath: string }> = [];
  for (const device of DEVICES) {
    const safe = device.id.replace(/:/g, '_');
    const token = authority.issueToken(device.id, 15); // 15 min - janela de matricula em campo
    const result = enrollDevice(authority, device.id, token);
    if (!result) {
      console.error(`  FALHA ao matricular ${device.id}`);
      continue;
    }
    const certPath = `${PKI_DIR}/${safe}.crt.pem`;
    const keyPath = `${PKI_DIR}/${safe}.key.pem`;
    writeFileSync(certPath, result.certBundle.certPem);
    writeFileSync(keyPath, result.keyPair.privateKeyPem);
    enrolled.push({ id: device.id, serial: result.certBundle.serial, certPath, keyPath });
    console.log(`  ✓ ${device.id}  serial=${result.certBundle.serial.slice(0, 16)}…  validade=${LEAF_VALIDITY_DAYS}d`);
  }

  writeFileSync(`${PKI_DIR}/manifest.json`, JSON.stringify({
    generated_at: new Date().toISOString(),
    root_validity_days: ROOT_VALIDITY_DAYS, issuing_validity_days: ISSUING_VALIDITY_DAYS, leaf_validity_days: LEAF_VALIDITY_DAYS,
    devices: enrolled,
  }, null, 2));

  console.log(`\n${enrolled.length}/${DEVICES.length} dispositivos matriculados em ${PKI_DIR}/`);
  console.log('  root-key.pem       - Root CA (bancada apenas; em campo, air-gapped)');
  console.log('  issuing-key.pem    - Issuing CA (assina matriculas em runtime)');
  console.log('  chain.pem          - cadeia completa para verificacao TLS');
  console.log('  <id>.crt.pem/.key.pem - identidade de cada dispositivo');
  console.log('\nEsta PKI autentica o SALTO ate o broker (mTLS).');
  console.log('A assinatura Ed25519 no envelope (npm run keys) continua autenticando a MENSAGEM fim-a-fim.');
}

main();
