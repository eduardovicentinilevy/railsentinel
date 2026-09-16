import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import snmp from 'net-snmp';
import { createAuthenticatedScalarAgent } from '@railsentinel/ntcip-emulator/dist/snmpv3-agent.js';

/**
 * Testes de integracao SNMPv3/USM contra um agente real - nao mock do
 * protocolo. O que importa aqui e que o OpenSSL/USM do proprio net-snmp
 * aceite ou recuse exatamente como o desenho pretende, incluindo o
 * bug real encontrado ao integrar: provider sem 'maxAccess' falha com
 * NoAccess em toda consulta, disfarçado de problema de credencial.
 */

const OID = '1.3.6.1.4.1.1206.4.2.1.20.1.92';
const CREDS = { user: 'railsentinel-ats', authKey: 'chave-de-autenticacao-forte', privKey: 'chave-de-privacidade-forte' };

let nextPort = 21610;
function port(): number { return nextPort++; }

const agents: Array<{ close: () => void }> = [];
after(() => { for (const a of agents) a.close(); });

function get(p: number, oid: string, user: Parameters<typeof snmp.createV3Session>[1]): Promise<{ ok: boolean; value?: number; error?: string }> {
  return new Promise((resolve) => {
    const session = snmp.createV3Session('127.0.0.1', user, { port: p, timeout: 1500, retries: 0 });
    session.get([oid], (err, varbinds) => {
      session.close();
      if (err) return resolve({ ok: false, error: err.message });
      if (snmp.isVarbindError(varbinds[0])) return resolve({ ok: false, error: snmp.varbindError(varbinds[0]) });
      resolve({ ok: true, value: varbinds[0]!.value as number });
    });
  });
}

const validUser = (name = CREDS.user) => ({
  name, level: snmp.SecurityLevel.authPriv,
  authProtocol: snmp.AuthProtocols.sha256, authKey: CREDS.authKey,
  privProtocol: snmp.PrivProtocols.aes, privKey: CREDS.privKey,
});

describe('SNMPv3/USM - agente autenticado do HIL NTCIP', () => {
  test('credenciais corretas leem o valor real do OID', async () => {
    const p = port();
    const scalar = createAuthenticatedScalarAgent(p, [OID], CREDS);
    agents.push(scalar);
    scalar.setValue(OID, 42);

    const r = await get(p, `${OID}.0`, validUser());
    assert.equal(r.ok, true, r.error);
    assert.equal(r.value, 42);
  });

  test('senha de autenticacao errada e recusada', async () => {
    const p = port();
    const scalar = createAuthenticatedScalarAgent(p, [OID], CREDS);
    agents.push(scalar);

    const wrongUser = { ...validUser(), authKey: 'senha-forjada' };
    const r = await get(p, `${OID}.0`, wrongUser);
    assert.equal(r.ok, false, 'GET com senha errada nunca deve retornar o valor');
  });

  test('usuario inexistente e recusado com erro USM padrao', async () => {
    const p = port();
    const scalar = createAuthenticatedScalarAgent(p, [OID], CREDS);
    agents.push(scalar);

    const r = await get(p, `${OID}.0`, validUser('usuario-que-nao-existe'));
    assert.equal(r.ok, false);
    assert.match(r.error ?? '', /Unknown User/);
  });

  test('senha de privacidade (cifra) errada e recusada mesmo com auth correta', async () => {
    const p = port();
    const scalar = createAuthenticatedScalarAgent(p, [OID], CREDS);
    agents.push(scalar);

    const wrongPriv = { ...validUser(), privKey: 'cifra-forjada' };
    const r = await get(p, `${OID}.0`, wrongPriv);
    assert.equal(r.ok, false);
  });

  test('nivel de seguranca inferior (noAuthNoPriv) e recusado para usuario configurado como authPriv', async () => {
    const p = port();
    const scalar = createAuthenticatedScalarAgent(p, [OID], CREDS);
    agents.push(scalar);

    const downgraded = { name: CREDS.user, level: snmp.SecurityLevel.noAuthNoPriv };
    const r = await get(p, `${OID}.0`, downgraded);
    assert.equal(r.ok, false, 'nao deve ser possivel degradar o nivel de seguranca de um usuario ja provisionado com authPriv');
  });

  test('regressao: provider sem maxAccess falhava com NoAccess mesmo com credenciais corretas', async () => {
    // Este teste existe porque o bug NAO aparecia como erro de credencial -
    // aparecia como NoAccess indistinguivel de "usuario sem permissao", e so
    // foi diagnosticado comparando com o codigo-fonte de isAllowed() do
    // proprio net-snmp. createAuthenticatedScalarAgent() ja inclui o fix
    // (maxAccess: 'read-only'); este teste falharia se alguem removesse essa
    // linha durante uma futura refatoracao.
    const p = port();
    const scalar = createAuthenticatedScalarAgent(p, [OID], CREDS);
    agents.push(scalar);
    scalar.setValue(OID, 7);

    const r = await get(p, `${OID}.0`, validUser());
    assert.equal(r.ok, true, `deveria ler o valor, mas: ${r.error}`);
    assert.equal(r.value, 7);
  });

  test('valores atualizados via setValue refletem na proxima consulta', async () => {
    const p = port();
    const scalar = createAuthenticatedScalarAgent(p, [OID], CREDS);
    agents.push(scalar);

    scalar.setValue(OID, 1);
    const first = await get(p, `${OID}.0`, validUser());
    scalar.setValue(OID, 99);
    const second = await get(p, `${OID}.0`, validUser());

    assert.equal(first.value, 1);
    assert.equal(second.value, 99);
  });

  test('consulta ao OID base (sem .0) falha - objetos escalares residem em OID.0', async () => {
    // Bug de convencao encontrado na integracao: um objeto escalar SNMP so
    // existe em OID+'.0' (a instancia), nunca no OID base (o no da arvore).
    // net-snmp so adiciona a instancia '.0' na primeira chamada de
    // setScalarValue(); consultar o OID sem o sufixo sempre falha, e a
    // primeira tentativa de verificacao manual desta integracao caiu
    // exatamente nisso antes de ser diagnosticada.
    const p = port();
    const scalar = createAuthenticatedScalarAgent(p, [OID], CREDS);
    agents.push(scalar);
    scalar.setValue(OID, 5);

    const semSufixo = await get(p, OID, validUser());
    const comSufixo = await get(p, `${OID}.0`, validUser());
    assert.equal(semSufixo.ok, false, 'OID base nao e uma instancia consultavel');
    assert.equal(comSufixo.ok, true, comSufixo.error);
    assert.equal(comSufixo.value, 5);
  });
});
