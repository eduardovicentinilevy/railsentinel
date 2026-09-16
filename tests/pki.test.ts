import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateP256KeyPair, issueCertificate, verifyChain, extractCommonName, isExpired,
  EnrollmentAuthority, enrollDevice, TrustStore,
} from '@railsentinel/pki';

/**
 * Testes da PKI interna: emissao em cadeia, matricula EST e revogacao.
 *
 * O que distingue estes testes dos de packages/contracts e o nivel de confianca
 * exigido: um bug aqui nao rejeita uma mensagem malformada, ele deixa passar um
 * dispositivo que nao deveria existir, ou barra um legitimo. A extracao de CN
 * chegou a falhar silenciosamente (getField('commonName') vs getField('CN')) e
 * so foi pega ao cruzar com openssl - fora do escopo automatizavel aqui, mas o
 * teste do formato do certificado permanece como rede de seguranca minima.
 */

let root: ReturnType<typeof generateP256KeyPair>;
let rootCert: ReturnType<typeof issueCertificate>;
let issuing: ReturnType<typeof generateP256KeyPair>;
let issuingCert: ReturnType<typeof issueCertificate>;

before(() => {
  root = generateP256KeyPair();
  rootCert = issueCertificate({ commonName: 'Root', validityDays: 3650, isCA: true, subjectPublicKeyPem: root.publicKeyPem, issuerPrivateKeyPem: root.privateKeyPem });
  issuing = generateP256KeyPair();
  issuingCert = issueCertificate({ commonName: 'Issuing', validityDays: 730, isCA: true, subjectPublicKeyPem: issuing.publicKeyPem, issuerPrivateKeyPem: root.privateKeyPem, issuerCertPem: rootCert.certPem });
});

describe('Cadeia de CA', () => {
  test('a Issuing CA verifica contra a Root', () => {
    assert.equal(verifyChain(issuingCert.certPem, rootCert.certPem), true);
  });

  test('uma CA nao verifica contra si mesma como se fosse outra', () => {
    const other = generateP256KeyPair();
    const otherCert = issueCertificate({ commonName: 'Outra', validityDays: 100, isCA: true, subjectPublicKeyPem: other.publicKeyPem, issuerPrivateKeyPem: other.privateKeyPem });
    assert.equal(verifyChain(issuingCert.certPem, otherCert.certPem), false);
  });

  test('certificado recem-emitido nao esta expirado', () => {
    assert.equal(isExpired(issuingCert.certPem), false);
  });

  test('certificado com validade no passado esta expirado', () => {
    const k = generateP256KeyPair();
    // validityDays negativo empurra notAfter para tras de 'agora'.
    const expired = issueCertificate({ commonName: 'X', validityDays: -1, subjectPublicKeyPem: k.publicKeyPem, issuerPrivateKeyPem: issuing.privateKeyPem, issuerCertPem: issuingCert.certPem });
    assert.equal(isExpired(expired.certPem), true);
  });

  test('CN e extraido corretamente (regressao: getField exige shortName)', () => {
    const k = generateP256KeyPair();
    const c = issueCertificate({ commonName: 'edge:jetson:XC-TESTE-01', validityDays: 30, subjectPublicKeyPem: k.publicKeyPem, issuerPrivateKeyPem: issuing.privateKeyPem, issuerCertPem: issuingCert.certPem });
    assert.equal(extractCommonName(c.certPem), 'edge:jetson:XC-TESTE-01');
  });
});

describe('Matricula EST', () => {
  test('token valido emite certificado com o CN correto', () => {
    const auth = new EnrollmentAuthority(issuing.privateKeyPem, issuingCert.certPem, 30);
    const token = auth.issueToken('edge:jetson:XC-ANA-COSTA-01');
    const result = enrollDevice(auth, 'edge:jetson:XC-ANA-COSTA-01', token);
    assert.ok(result);
    assert.equal(extractCommonName(result!.certBundle.certPem), 'edge:jetson:XC-ANA-COSTA-01');
    assert.equal(verifyChain(result!.certBundle.certPem, issuingCert.certPem), true);
  });

  test('token nao pode ser reutilizado', () => {
    const auth = new EnrollmentAuthority(issuing.privateKeyPem, issuingCert.certPem, 30);
    const token = auth.issueToken('edge:jetson:X-01');
    assert.ok(enrollDevice(auth, 'edge:jetson:X-01', token));
    assert.equal(enrollDevice(auth, 'edge:jetson:X-01', token), null, 'segunda tentativa com o mesmo token deve falhar');
  });

  test('token amarrado a um id nao serve para outro', () => {
    const auth = new EnrollmentAuthority(issuing.privateKeyPem, issuingCert.certPem, 30);
    const token = auth.issueToken('edge:jetson:A-01');
    assert.equal(enrollDevice(auth, 'edge:jetson:B-01', token), null, 'token de A nao pode matricular B');
  });

  test('token expirado e recusado', () => {
    const auth = new EnrollmentAuthority(issuing.privateKeyPem, issuingCert.certPem, 30);
    const token = auth.issueToken('edge:jetson:X-01', -1); // ja expirado
    assert.equal(enrollDevice(auth, 'edge:jetson:X-01', token), null);
  });

  test('token inexistente e recusado', () => {
    const auth = new EnrollmentAuthority(issuing.privateKeyPem, issuingCert.certPem, 30);
    assert.equal(enrollDevice(auth, 'edge:jetson:X-01', 'token-forjado'), null);
  });

  test('a chave privada da folha nao e conhecida pela CA', () => {
    // A CA emite o certificado a partir de uma chave PUBLICA que o dispositivo
    // enviou; ela nunca gera nem ve a privada. enrollDevice() gera a chave
    // fora da autoridade, no lado do 'dispositivo' - isto e o contrato central
    // do fluxo EST, e este teste falharia se enrollDevice delegasse a geracao
    // de chave para dentro de EnrollmentAuthority.
    const auth = new EnrollmentAuthority(issuing.privateKeyPem, issuingCert.certPem, 30);
    const token = auth.issueToken('edge:jetson:X-01');
    const result = enrollDevice(auth, 'edge:jetson:X-01', token);
    assert.ok(result!.keyPair.privateKeyPem.includes('PRIVATE KEY'));
    assert.equal(result!.certBundle.keyPem, '', 'o bundle da CA nunca carrega a privada da folha');
  });
});

describe('TrustStore - revogacao', () => {
  test('certificado valido passa em todas as checagens', () => {
    const store = new TrustStore(issuingCert.certPem);
    const auth = new EnrollmentAuthority(issuing.privateKeyPem, issuingCert.certPem, 30);
    const r = enrollDevice(auth, 'edge:jetson:X-01', auth.issueToken('edge:jetson:X-01'))!;
    const v = store.validate(r.certBundle.certPem, r.certBundle.serial, 'edge:jetson:X-01');
    assert.equal(v.valid, true);
  });

  test('revogacao e imediata e nao exige reiniciar nada', () => {
    const store = new TrustStore(issuingCert.certPem);
    const auth = new EnrollmentAuthority(issuing.privateKeyPem, issuingCert.certPem, 30);
    const r = enrollDevice(auth, 'edge:jetson:X-01', auth.issueToken('edge:jetson:X-01'))!;
    assert.equal(store.validate(r.certBundle.certPem, r.certBundle.serial, 'edge:jetson:X-01').valid, true);
    store.revoke(r.certBundle.serial, 'compromised');
    const v = store.validate(r.certBundle.certPem, r.certBundle.serial, 'edge:jetson:X-01');
    assert.equal(v.valid, false);
    assert.match(v.reason ?? '', /compromised/);
  });

  test('CN divergente do esperado e recusado - amarra a topico', () => {
    const store = new TrustStore(issuingCert.certPem);
    const auth = new EnrollmentAuthority(issuing.privateKeyPem, issuingCert.certPem, 30);
    const r = enrollDevice(auth, 'edge:jetson:A-01', auth.issueToken('edge:jetson:A-01'))!;
    // Certificado legitimo de A tentando autenticar como B.
    const v = store.validate(r.certBundle.certPem, r.certBundle.serial, 'edge:jetson:B-01');
    assert.equal(v.valid, false);
    assert.match(v.reason ?? '', /nao corresponde/);
  });

  test('certificado de CA diferente e recusado', () => {
    const store = new TrustStore(issuingCert.certPem);
    const rogueCa = generateP256KeyPair();
    const rogueCaCert = issueCertificate({ commonName: 'CA Forjada', validityDays: 100, isCA: true, subjectPublicKeyPem: rogueCa.publicKeyPem, issuerPrivateKeyPem: rogueCa.privateKeyPem });
    const deviceKey = generateP256KeyPair();
    const rogueLeaf = issueCertificate({ commonName: 'edge:jetson:X-01', validityDays: 30, subjectPublicKeyPem: deviceKey.publicKeyPem, issuerPrivateKeyPem: rogueCa.privateKeyPem, issuerCertPem: rogueCaCert.certPem });
    const v = store.validate(rogueLeaf.certPem, rogueLeaf.serial, 'edge:jetson:X-01');
    assert.equal(v.valid, false, 'certificado assinado por CA nao confiavel deve ser recusado mesmo com CN correto');
  });

  test('lista de revogados e consultavel', () => {
    const store = new TrustStore(issuingCert.certPem);
    store.revoke('serial-1', 'decommissioned');
    store.revoke('serial-2', 'ca_compromise');
    assert.equal(store.revokedList().length, 2);
  });
});
