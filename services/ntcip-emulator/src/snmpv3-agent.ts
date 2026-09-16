import snmp from 'net-snmp';

/**
 * Agente SNMP escalar com autenticacao SNMPv3/USM - extraido para ser
 * testavel isoladamente, sem subir o barramento MQTT nem a maquina de estados
 * do controlador semaforico.
 *
 * community string em claro (SNMPv1/v2c) e inaceitavel para um objeto que
 * controla prioridade em cruzamento urbano: qualquer um na rede conseguiria
 * ler o estado do sinal. authPriv exige autenticacao (SHA-256) e cifra o
 * payload (AES) - uma tentativa sem as credenciais corretas nao recebe erro
 * informativo, apenas timeout ou 'Unknown User Name' (RFC 3414: nome de
 * usuario nao e segredo, mas a chave e).
 */

export interface Snmpv3Credentials {
  user: string;
  authKey: string;
  privKey: string;
}

export interface AuthenticatedScalarAgent {
  agent: snmp.Agent;
  /** Atualiza o valor servido para um OID ja registrado. */
  setValue(oid: string, value: number): void;
  close(): void;
}

export function createAuthenticatedScalarAgent(
  port: number,
  oids: readonly string[],
  credentials: Snmpv3Credentials,
  onError?: (err: Error) => void,
): AuthenticatedScalarAgent {
  const store = new Map<string, number>();

  const agent = snmp.createAgent(
    { port, disableAuthorization: false, accessControlModelType: snmp.AccessControlModelType.Simple },
    (error: Error | null) => { if (error && onError) onError(error); },
  );

  agent.getAuthorizer().addUser({
    name: credentials.user, level: snmp.SecurityLevel.authPriv,
    authProtocol: snmp.AuthProtocols.sha256, authKey: credentials.authKey,
    privProtocol: snmp.PrivProtocols.aes, privKey: credentials.privKey,
  });

  const mib = agent.getMib();
  for (const oid of oids) {
    const name = oid.replace(/\./g, '_');
    try {
      mib.registerProvider({
        name, type: snmp.MibProviderType.Scalar, oid, scalarType: snmp.ObjectType.Integer,
        // Sem isto, TODO GetRequest falha com NoAccess antes mesmo de chegar
        // na checagem de usuario SNMPv3/USM - net-snmp usa provider.maxAccess
        // (RFC 1213 MAX-ACCESS) como primeiro portao de autorizacao, e o valor
        // default sem essa declaracao nao satisfaz "pelo menos read-only".
        // Bug real, encontrado so ao testar GET de ponta a ponta com um
        // cliente SNMPv3 de verdade - registrar o provider sem isto parece
        // funcionar (nenhum erro na inicializacao) e falha silenciosamente em
        // toda consulta, sempre com NoAccess, disfarçando-se de problema de
        // credencial.
        maxAccess: snmp.MaxAccess['read-only'],
        handler: (mibRequest: { done: (r: { type: number; value: number }) => void }) => {
          mibRequest.done({ type: snmp.ObjectType.Integer, value: store.get(oid) ?? 0 });
        },
      });
      mib.setScalarValue(name, 0);
    } catch {
      // OIDs duplicados no mapa de alias do chamador - ignorar silenciosamente.
    }
  }

  return {
    agent,
    setValue: (oid, value) => store.set(oid, value),
    close: () => agent.close(),
  };
}
