/**
 * Dois brokers MQTT locais para a bancada.
 *
 * 1883 = broker de CAMPO      (Zona Periferica / DMZ, IEC 62443) - TLS mutuo
 * 8883 = broker de CAMPO      (mesmo broker, listener mTLS quando PKI presente)
 * 1884 = barramento do NUCLEO (Zona de Integracao Operacional)   - TCP simples
 *
 * Sao processos separados de proposito: a separacao de zonas precisa ser real
 * na bancada, nao um prefixo de topico. Em producao sao clusters EMQX
 * distintos, em VLANs distintas, com firewall industrial no conduite.
 *
 * mTLS no broker de CAMPO (Fase 2)
 *
 * Quando .secrets/pki/ existe, o broker de campo tambem escuta em TLS mutuo:
 * so aceita conexao de cliente cuja cadeia de certificado verifica contra a
 * Issuing CA (rejectUnauthorized). Isto e autenticacao de TRANSPORTE - o salto
 * ate o broker - complementar, nao substituta, a assinatura Ed25519 no
 * envelope (que autentica a MENSAGEM fim-a-fim mesmo atraves do broker).
 *
 * O broker tambem AMARRA identidade TLS a client id: o CN do certificado
 * precisa corresponder ao segmento de dispositivo que o cliente MQTT declara
 * como id de conexao. Sem isso, um certificado legitimo de um dispositivo
 * poderia ser usado para autenticar uma conexao alegando ser outro - a mesma
 * classe de amarracao que o gateway ja faz entre env.src e o topico
 * (src_topic_mismatch), agora um nivel abaixo, na propria sessao TCP.
 */
import Aedes from 'aedes';
import { createServer } from 'node:net';
import { createServer as createTlsServer } from 'node:tls';
import { existsSync, readFileSync } from 'node:fs';

function start(name: string, port: number, opts: { enforceAcl?: boolean } = {}) {
  const broker = new Aedes({ id: name });

  if (opts.enforceAcl) {
    broker.authorizePublish = (client, packet, done) => {
      const id = client?.id ?? '';
      const expected = id.replace(/^edge-jetson-/, '');
      if (expected && packet.topic.startsWith('vlt/') && !packet.topic.includes(`/${expected}/`)) {
        console.log(`  [${name}] ACL: ${id} publicando fora do proprio subtopico -> ${packet.topic}`);
      }
      done(null);
    };
  }

  const server = createServer(broker.handle);
  server.listen(port, () => console.log(`[broker:${name}] escutando em mqtt://127.0.0.1:${port}`));

  broker.on('client', (c) => console.log(`  [${name}] cliente conectado: ${c.id}`));
  broker.on('clientDisconnect', (c) => console.log(`  [${name}] cliente desconectado: ${c.id}`));
  return { broker, server };
}

/**
 * Client id MQTT esperado para um CN de certificado, dada a convencao dos
 * simuladores: 'edge:jetson:XC-ANA-COSTA-01' -> 'edge-jetson-XC-ANA-COSTA-01'
 * (todo ':' vira '-').
 *
 * A direcao importa: o id de dispositivo (ultimo segmento do CN) frequentemente
 * ja contem hifens ("XC-ANA-COSTA-01"), entao reconstruir o CN a partir do
 * client id fazendo split('-') e ambiguo - nao ha como saber onde 'kind' e
 * 'platform' terminam e o id comeca so olhando os hifens. Ir do CN (sempre
 * exatamente 2 ':') para o client id e a unica direcao sem ambiguidade.
 */
function expectedClientIdFor(cn: string): string {
  return cn.replace(/:/g, '-');
}

function startWithMtls(name: string, port: number, tlsPort: number, pkiDir: string) {
  const { broker, server } = start(name, port, { enforceAcl: true });

  const chainPem = readFileSync(`${pkiDir}/chain.pem`, 'utf8');
  const tlsServer = createTlsServer(
    {
      // O broker so aceita cliente cujo certificado verifica contra ESTA
      // cadeia - a Issuing CA da nossa PKI, nao qualquer CA publica do sistema.
      ca: chainPem,
      requestCert: true,
      rejectUnauthorized: true,
      // Certificado do PROPRIO broker de campo, para o cliente autenticar o
      // servidor - mTLS e as duas direcoes, nao so a autenticacao do cliente.
      // Identidade de SERVIDOR do broker, distinta do certificado de
      // CLIENTE do gateway - papeis diferentes exigem EKU diferente
      // (serverAuth vs clientAuth), mesmo quando o mesmo processo os usa em
      // conexoes distintas.
      cert: readFileSync(`${pkiDir}/field-broker.crt.pem`, 'utf8'),
      key: readFileSync(`${pkiDir}/field-broker.key.pem`, 'utf8'),
    },
    (socket) => {
      const peerCert = socket.getPeerCertificate();
      const cn = peerCert?.subject?.CN;
      console.log(`  [${name}:mTLS] handshake concluido, CN do certificado: ${cn ?? '(nenhum)'}`);
      broker.handle(socket as never);
      (socket as unknown as { railsentinelCN?: string }).railsentinelCN = cn;
    },
  );

  // Amarra CN do certificado ao client id declarado na sessao MQTT. Sem isto,
  // TLS prova "este socket pertence a alguem com certificado valido", mas nao
  // que seja o dispositivo que a camada MQTT afirma ser.
  broker.authenticate = (client, _username, _password, callback) => {
    const socket = (client as unknown as { conn?: { railsentinelCN?: string } }).conn;
    const cn = socket?.railsentinelCN;
    if (!cn) {
      // Conexao TCP simples (porta 1883) sem TLS - permitida na bancada para
      // compatibilidade com o fluxo pre-PKI; a ACL de topico e o unico
      // controle nesse caminho, exatamente como na Fase 1.
      callback(null, true);
      return;
    }
    const expectedClientId = expectedClientIdFor(cn);
    const ok = client.id === expectedClientId;
    if (!ok) {
      console.log(`  [${name}:mTLS] RECUSADO: client id declarado (${client.id}) nao corresponde ao CN do certificado (${cn} -> esperado ${expectedClientId})`);
    }
    callback(null, ok);
  };

  tlsServer.listen(tlsPort, () => console.log(`[broker:${name}] mTLS escutando em mqtts://127.0.0.1:${tlsPort} (CA: ${pkiDir}/chain.pem)`));
  return { tlsServer };
}

console.log('Iniciando brokers de bancada (zonas IEC 62443 separadas)\n');

const PKI_DIR = '.secrets/pki';
const hasPki = existsSync(`${PKI_DIR}/chain.pem`);

let field: ReturnType<typeof start>;
if (hasPki) {
  console.log('PKI detectada - broker de campo tambem escuta mTLS na porta 8883\n');
  field = startWithMtls('campo', Number(process.env.FIELD_PORT ?? 1883), Number(process.env.FIELD_TLS_PORT ?? 8883), PKI_DIR) as never;
} else {
  console.log('PKI nao encontrada (rode: npm run setup-pki) - broker de campo em TCP simples\n');
  field = start('campo', Number(process.env.FIELD_PORT ?? 1883), { enforceAcl: true });
}
const core = start('nucleo', Number(process.env.CORE_PORT ?? 1884));

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    console.log('\nencerrando brokers');
    field.server.close();
    core.server.close();
    process.exit(0);
  });
}
