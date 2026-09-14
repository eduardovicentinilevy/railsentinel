/**
 * Dois brokers MQTT locais para a bancada.
 *
 * 1883 = broker de CAMPO      (Zona Periferica / DMZ, IEC 62443)
 * 1884 = barramento do NUCLEO (Zona de Integracao Operacional)
 *
 * Sao processos separados de proposito: a separacao de zonas precisa ser real
 * na bancada, nao um prefixo de topico. Rodar tudo num broker so tornaria
 * trivial - e invisivel - um servico do nucleo assinar topico de campo, que e
 * exatamente o atalho que a arquitetura proibe. Em producao sao clusters EMQX
 * distintos, em VLANs distintas, com firewall industrial no conduite.
 */
import Aedes from 'aedes';
import { createServer } from 'node:net';

function start(name: string, port: number, opts: { enforceAcl?: boolean } = {}) {
  const broker = new Aedes({ id: name });

  if (opts.enforceAcl) {
    // Espelha a ACL do EMQX: o dispositivo so publica sob o proprio ID.
    // Aqui e permissivo (so registra) para que o cenario 'spoof' consiga
    // emitir a tentativa e o gateway demonstre a recusa na camada de aplicacao.
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

console.log('Iniciando brokers de bancada (zonas IEC 62443 separadas)\n');
const field = start('campo', Number(process.env.FIELD_PORT ?? 1883), { enforceAcl: true });
const core = start('nucleo', Number(process.env.CORE_PORT ?? 1884));

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    console.log('\nencerrando brokers');
    field.server.close();
    core.server.close();
    process.exit(0);
  });
}
