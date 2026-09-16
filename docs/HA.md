# Alta Disponibilidade — Eleição de Líder (Fase 2)

Reproduzir: `tests/leader-election.test.ts` · verificação ao vivo abaixo

---

## O ponto de partida: por que réplicas ingênuas são uma falha de segurança

`ARQUITETURA.md §1.3` já registrava isto na Fase 1:

> Rodar três réplicas do ATS não é alta disponibilidade — é uma falha de
> segurança. Três instâncias regulando a mesma linha emitem três ajustes de
> dwell conflitantes para a mesma composição. O modo de falha não é
> indisponibilidade; é comando incoerente, que é pior.

Este documento fecha essa lacuna: `ats-core` agora tolera múltiplas instâncias
rodando lado a lado, com a garantia de que **exatamente uma** publica
qualquer decisão no barramento a qualquer momento.

## Mecanismo: lease com fencing token sobre PostgreSQL

```sql
CREATE TABLE leader_lease (
  role text PRIMARY KEY, holder text, epoch bigint, acquired_at, expires_at
);
```

Toda a lógica de decisão vive numa única instrução SQL por operação — a
atomicidade vem do próprio PostgreSQL (MVCC + `PRIMARY KEY`), não de um mutex
em processo que só protegeria contra concorrência dentro do mesmo serviço.

| operação | efeito |
|---|---|
| `tryAcquire` | só sucede se o lease atual **já expirou**; sempre incrementa o epoch |
| `renew` | estende o lease **sem** trocar epoch; só sucede se `holder` e `epoch` ainda baterem |
| `release` | expira o lease imediatamente (desligamento gracioso) |

**Fencing token**, o conceito central: um líder deposto por pausa de GC ou
partição de rede pode continuar se achando líder — mas o epoch que ele carrega
fica desatualizado no instante em que outro processo assume, e `renew()` com
epoch velho falha de forma atômica no próprio banco. Sem isso, dois processos
convencidos de serem líder ao mesmo tempo é exatamente o cenário que a eleição
deveria impedir.

## Desenho: standby fica quente, nunca fala

Toda instância do `ats-core` — líder ou não — assina o barramento e processa
**cada mensagem normalmente**: `FleetRegistry`, incidentes abertos,
inibições de TSP ficam atualizados em standby. Só a publicação de volta ao
barramento é condicionada:

```ts
function publishAsLeader(topic, payload, opts) {
  if (!leader.isLeader()) { log('standby - suprimido'); return; }
  bus.publish(topic, payload, opts);
}
```

Os 10 pontos de publicação de efeito do `ats-core` (alarme, restrição,
decisão de TSP, comando de regulação, violação de partição, estado do
sistema) passam por este único ponto — o mesmo espírito do `SafetyGuard`,
agora para o problema de escritor único.

A escolha de manter o standby "quente" em vez de ocioso é deliberada: no
failover, o novo líder já tem o `FleetRegistry` populado e os incidentes
abertos conhecidos — não há janela em que a proteção contra invasão de via
"esquece" uma restrição ativa enquanto reconstrói estado a partir do zero.

## Verificação ao vivo

```
duas instâncias, DATABASE_URL compartilhado, lease de 2s:

  A: ASSUMIU a lideranca - passa a publicar decisoes
  (B permanece silenciosa - onChange notificou standby, sem re-log a cada tick)

  $ kill -9 <pid-A>          # crash, sem shutdown gracioso

  B: em STANDBY - continua processando, mas nao publica nada    (log inicial)
  B: ASSUMIU a lideranca - passa a publicar decisoes             (~5s depois)
```

Failover completo em menos de `leaseDurationMs + retryIntervalMs` — no teste
acima, sob 3 segundos com lease de 2s.

## Dois bugs reais encontrados na integração

**Client id MQTT colidindo entre instâncias.** As duas instâncias usavam o
client id fixo `'ats-core'`. Por especificação MQTT, uma nova conexão com o
mesmo client id derruba a anterior — as duas instâncias entravam num ciclo de
desconexão/reconexão a cada poucos segundos, e a causa não tinha nada a ver
com a eleição de líder em si. Corrigido: client id inclui `INSTANCE_ID`.

**`onChange` nunca disparava para uma instância que nasce e permanece em
standby.** A transição é `null -> null` — tecnicamente "sem mudança" — então
uma instância que tenta adquirir e falha repetidamente nunca notificava nada.
Um operador olhando o log dessa instância veria silêncio total, sem forma de
distinguir "viva e corretamente em standby" de "travou antes de tentar".
Bug duplo: (1) a lógica de notificação exigia mudança de estado, corrigido
para sempre notificar na primeira avaliação; (2) mesmo após esse fix,
`#setEpoch` só era chamado no caminho de **sucesso** da aquisição — o ramo de
falha nunca invocava a função que continha a correção. Os dois precisaram ser
corrigidos juntos; testado explicitamente em
`tests/leader-election.test.ts`.

## Ressalvas

1. **PostgreSQL é o único coordenador.** Não há Raft nem etcd — a garantia de
   atomicidade vem inteiramente do MVCC do Postgres sobre uma tabela com
   `PRIMARY KEY`. Suficiente para dois-a-poucos processos de um mesmo
   serviço; um cluster de coordenação dedicado (etcd) seria a escolha para
   coordenar múltiplos serviços distintos.
2. **Um único ponto de coordenação.** Se o PostgreSQL cair, toda instância
   perde a lideranca (por design — `LeaseHolder` trata falha de conexão como
   perda de liderança) e nenhuma publica. Isso é conservador e correto do
   ponto de vista de segurança (nunca dois líderes), mas significa que a
   disponibilidade do `ats-core` está acoplada à do banco. A HA do próprio
   PostgreSQL (`ARQUITETURA.md §1.4`, réplica via Patroni) é pré-requisito
   para a HA do `ats-core`, não uma camada independente.
3. **Fencing por epoch não é verificado a jusante.** Os consumidores
   (`operator-api`, `historian`) não comparam epochs — a garantia de escritor
   único vem inteiramente do lado do publicador (só o líder publica). Um
   consumidor que quisesse detectar e descartar uma decisão de epoch
   retroativo (defesa adicional contra a rara janela entre "renew falhou
   silenciosamente" e "o processo percebeu") precisaria do epoch embutido em
   cada mensagem — não implementado nesta fase.
