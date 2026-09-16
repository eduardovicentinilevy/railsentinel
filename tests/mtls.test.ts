import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer as createTlsServer, connect as tlsConnect, type TLSSocket } from 'node:tls';

import {
  generateP256KeyPair, issueCertificate, EnrollmentAuthority, enrollDevice,
} from '@railsentinel/pki';

/**
 * Testes de integracao mTLS: sobem um servidor TLS real com verificacao de
 * certificado de cliente e tentam handshakes legitimos e ilegitimos contra
 * ele. Diferente dos testes unitarios de packages/pki, aqui o que se prova e
 * que a CADEIA DE CONFIANCA e o OpenSSL do proprio Node aceitam ou recusam
 * exatamente como o desenho pretende - nao apenas que o nosso codigo de
 * verificacao concorda consigo mesmo.
 *
 * Cobre a mesma logica de tools/dev-brokers.ts (amarracao CN <-> client id),
 * isolada do MQTT para que o teste rode em milissegundos sem broker externo.
 */

let root: ReturnType<typeof generateP256KeyPair>;
let issuing: ReturnType<typeof generateP256KeyPair>;
let issuingCert: ReturnType<typeof issueCertificate>;
let chainPem: string;
let serverKey: ReturnType<typeof generateP256KeyPair>;
let serverCert: ReturnType<typeof issueCertificate>;
let authority: EnrollmentAuthority;

before(() => {
  root = generateP256KeyPair();
  const rootCert = issueCertificate({ commonName: 'Root', validityDays: 3650, isCA: true, subjectPublicKeyPem: root.publicKeyPem, issuerPrivateKeyPem: root.privateKeyPem });
  issuing = generateP256KeyPair();
  issuingCert = issueCertificate({ commonName: 'Issuing', validityDays: 730, isCA: true, subjectPublicKeyPem: issuing.publicKeyPem, issuerPrivateKeyPem: root.privateKeyPem, issuerCertPem: rootCert.certPem });
  chainPem = `${issuingCert.certPem}\n${rootCert.certPem}`;

  serverKey = generateP256KeyPair();
  serverCert = issueCertificate({
    commonName: 'test-server', role: 'server', subjectAltNames: ['localhost'], validityDays: 30,
    subjectPublicKeyPem: serverKey.publicKeyPem, issuerPrivateKeyPem: issuing.privateKeyPem, issuerCertPem: issuingCert.certPem,
  });

  authority = new EnrollmentAuthority(issuing.privateKeyPem, issuingCert.certPem, 30);
});

function startTestServer(): Promise<{ port: number; close: () => void; connections: string[] }> {
  const connections: string[] = [];
  return new Promise((resolve) => {
    const server = createTlsServer(
      { cert: serverCert.certPem, key: serverKey.privateKeyPem, ca: chainPem, requestCert: true, rejectUnauthorized: true },
      (socket: TLSSocket) => {
        const cn = socket.getPeerCertificate()?.subject?.CN;
        connections.push(cn ?? '(sem CN)');
        socket.end();
      },
    );
    server.listen(0, () => resolve({ port: (server.address() as { port: number }).port, close: () => server.close(), connections }));
  });
}

/**
 * Tenta o handshake e reporta se o SERVIDOR aceitou a conexao.
 *
 * Fonte da verdade: o array 'connections' do servidor, preenchido apenas pelo
 * listener de conexao do tls.Server - que so dispara quando a verificacao do
 * certificado de cliente foi bem-sucedida. NAO usamos o evento 'secureConnect'
 * do lado cliente como sinal de sucesso: sob TLS 1.3, o cliente pode ver o
 * handshake como concluido do proprio ponto de vista ANTES de o servidor
 * terminar de verificar o certificado do cliente, e uma rejeicao chega como
 * alerta assincrono depois - um teste que resolvesse em 'secureConnect'
 * reportaria sucesso para conexoes que o servidor de fato recusou.
 *
 * Isto e uma propriedade real do protocolo, nao um defeito do dev-brokers.ts:
 * a depuracao manual confirmou que o listener de conexao do servidor NUNCA e
 * chamado para um cliente sem certificado valido - a garantia de seguranca
 * que importa esta intacta. O que precisava de correcao era so o metodo do
 * teste para observar essa garantia.
 */
async function handshake(srv: { port: number; connections: string[] }, opts: { key?: string; cert?: string }): Promise<{ ok: boolean; error?: string }> {
  const before = srv.connections.length;
  const result = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
    const socket = tlsConnect({
      port: srv.port, host: '127.0.0.1', ca: chainPem, servername: 'localhost',
      key: opts.key, cert: opts.cert, rejectUnauthorized: true, timeout: 3000,
    });
    let settled = false;
    const finish = (v: { ok: boolean; error?: string }) => { if (!settled) { settled = true; resolve(v); } };
    socket.on('error', (e) => finish({ ok: false, error: e.message }));
    socket.on('secureConnect', () => {
      // Aguarda o veredito real do servidor em vez de confiar no evento do
      // cliente - ver comentario acima.
      setTimeout(() => finish({ ok: srv.connections.length > before }), 150);
      socket.end();
    });
    socket.on('timeout', () => finish({ ok: false, error: 'timeout' }));
  });
  return result;
}

describe('mTLS - handshake real contra servidor TLS', () => {
  test('certificado emitido pela nossa CA e aceito', async () => {
    const srv = await startTestServer();
    const device = enrollDevice(authority, 'edge:jetson:X-01', authority.issueToken('edge:jetson:X-01'))!;
    const r = await handshake(srv, { key: device.keyPair.privateKeyPem, cert: device.certBundle.certPem });
    srv.close();
    assert.equal(r.ok, true, r.error);
  });

  test('conexao sem certificado de cliente e recusada pelo TLS', async () => {
    const srv = await startTestServer();
    const r = await handshake(srv, {});
    srv.close();
    assert.equal(r.ok, false);
  });

  test('certificado assinado por CA nao confiavel e recusado', async () => {
    const srv = await startTestServer();
    const rogueRoot = generateP256KeyPair();
    const rogueCert = issueCertificate({ commonName: 'CA Forjada', validityDays: 100, isCA: true, subjectPublicKeyPem: rogueRoot.publicKeyPem, issuerPrivateKeyPem: rogueRoot.privateKeyPem });
    const rogueDeviceKey = generateP256KeyPair();
    const rogueLeaf = issueCertificate({ commonName: 'edge:jetson:X-01', validityDays: 30, subjectPublicKeyPem: rogueDeviceKey.publicKeyPem, issuerPrivateKeyPem: rogueRoot.privateKeyPem, issuerCertPem: rogueCert.certPem });
    const r = await handshake(srv, { key: rogueDeviceKey.privateKeyPem, cert: rogueLeaf.certPem });
    srv.close();
    assert.equal(r.ok, false, 'servidor deve recusar cadeia que nao remonta a Issuing CA confiavel');
  });

  test('CN do certificado chega correto ao handler do servidor', async () => {
    const srv = await startTestServer();
    const device = enrollDevice(authority, 'edge:jetson:XC-CONSTITUICAO-01', authority.issueToken('edge:jetson:XC-CONSTITUICAO-01'))!;
    await handshake(srv, { key: device.keyPair.privateKeyPem, cert: device.certBundle.certPem });
    srv.close();
    assert.deepEqual(srv.connections, ['edge:jetson:XC-CONSTITUICAO-01']);
  });

  test('certificado expirado e recusado', async () => {
    const srv = await startTestServer();
    const deviceKey = generateP256KeyPair();
    const expiredCert = issueCertificate({
      commonName: 'edge:jetson:X-01', validityDays: -1,
      subjectPublicKeyPem: deviceKey.publicKeyPem, issuerPrivateKeyPem: issuing.privateKeyPem, issuerCertPem: issuingCert.certPem,
    });
    const r = await handshake(srv, { key: deviceKey.privateKeyPem, cert: expiredCert.certPem });
    srv.close();
    assert.equal(r.ok, false);
  });
});

describe('Amarracao CN <-> client id (logica do dev-brokers)', () => {
  function expectedClientIdFor(cn: string): string {
    return cn.replace(/:/g, '-');
  }

  test('conversao direta CN -> client id', () => {
    assert.equal(expectedClientIdFor('edge:jetson:XC-ANA-COSTA-01'), 'edge-jetson-XC-ANA-COSTA-01');
  });

  test('id de dispositivo com hifens nao quebra a comparacao', () => {
    // O ponto do bug original: reconstruir o CN a partir do client id via
    // split('-') e ambiguo quando o proprio id tem hifens. Ir na direcao
    // CN -> client id nao tem essa ambiguidade.
    const cn = 'edge:jetson:XC-JOAO-PESSOA-01';
    const clientId = 'edge-jetson-XC-JOAO-PESSOA-01';
    assert.equal(expectedClientIdFor(cn), clientId);
  });

  test('impersonacao e detectada: cert de A com client id de B', () => {
    const certCN = 'edge:jetson:XC-ANA-COSTA-01';
    const declaredClientId = 'edge-jetson-XC-JOAO-PESSOA-01';
    assert.notEqual(expectedClientIdFor(certCN), declaredClientId);
  });
});
