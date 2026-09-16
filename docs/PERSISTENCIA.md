# Persistência — Historiador (Fase 2)

Reproduzir: `npm run db:migrate` · testes: `tests/historian.test.ts`

---

## Por que isto muda em relação à Fase 1

Todo estado da Fase 1 vivia em memória de processo. Um reinício do `ats-core`
apagava a lista de incidentes abertos; não havia como responder "o que
aconteceu na seção L2-S11 entre 14h e 15h?" depois do fato. Isso é aceitável
numa bancada de contrato de mensageria — inaceitável para uma investigação
pós-incidente ou uma auditoria de conformidade, que precisam de registro
durável e consultável.

## PostgreSQL puro, não TimescaleDB — decisão registrada

A extensão TimescaleDB não está disponível nesta bancada (exigiria um
repositório apt externo, bloqueado pelo proxy da sessão). O schema
(`db/schema.sql`) é escrito para que a migração seja trivial quando a extensão
estiver disponível: cada tabela de série temporal tem uma única coluna de
tempo (`ts`/`at`) e é append-only (só `INSERT ... ON CONFLICT DO NOTHING`,
nunca `UPDATE` em linhas de evento).

```sql
-- Quando TimescaleDB estiver disponível, uma linha por tabela:
SELECT create_hypertable('telemetry_position', 'ts');
```

Nenhuma consulta muda — hypertables são consultadas com SQL idêntico ao
PostgreSQL puro. O mesmo padrão já foi usado para JSON→CBOR em
`ARQUITETURA.md §2.6`: a escolha de armazenamento é uma decisão de operação,
não de contrato.

## Idempotência: a mesma garantia do `ReplayGuard`, um nível abaixo

MQTT QoS 1 entrega ao menos uma vez. O `ingest-gateway` já deduplica na
fronteira por `(src, id)`; o historiador aplica a **mesma garantia**
independentemente, via `PRIMARY KEY (envelope_id)` + `ON CONFLICT DO NOTHING`.

Isto não é redundância acidental — é defesa em profundidade deliberada: se o
historiador reiniciar e reprocessar um tópico retido, ou se uma reentrega
escapar da deduplicação da fronteira por qualquer motivo, a escrita no banco
continua sendo idempotente. Testado explicitamente (`escrita e idempotente -
reentrega de QoS 1 nao duplica`): a mesma mensagem gravada três vezes produz
uma linha.

## O que fica gravado

| tabela | conteúdo | chave de idempotência |
|---|---|---|
| `telemetry_position` | posição da frota | `envelope_id` |
| `events_intrusion` | cada detecção de invasão, com `incident_id` para reconstruir a timeline | `envelope_id` |
| `alarms` | alarmes ao operador, com reconhecimento auditado (quem, quando) | `alarm_id` |
| `restrictions` | restrições de via, com liberação auditada | `restriction_id` |
| `audit_rejected` | recusas na fronteira IEC 62443 | — (evento malformado por definição) |
| `audit_safety_violations` | violações de partição EN 50716 barradas | — |
| `tsp_decisions` | pedidos de prioridade + desfecho real do HIL | — |

**`audit_safety_violations` vazia em produção normal é, ela própria, a
evidência de que a partição EN 50716 é executável** — a mesma afirmação de
`docs/ARQUITETURA.md §3`, agora com registro consultável em vez de apenas
comportamento em memória.

## Testes contra Postgres real, não mock de SQL

Um mock provaria que o código chama `pool.query()` com os argumentos certos;
não provaria que o SQL é válido, que os tipos de coluna aceitam os valores
enviados, ou que `ON CONFLICT DO NOTHING` de fato deduplica. `tests/historian.test.ts`
roda contra uma instância PostgreSQL real (`railsentinel_test`).

Ambiente sem Postgres acessível: os testes são pulados com motivo explícito
(`TEST_DATABASE_URL` inacessível), não falham a suíte inteira.

### Bug de API encontrado: `describe(..., { skip: fn })` não funciona

A tentativa inicial de pular condicionalmente em runtime foi:

```ts
describe('...', { skip: () => skipReason ?? false }, () => { ... });
```

`skip` só aceita `boolean | string`, não função — uma referência de função é
sempre *truthy* em JavaScript, então a suíte era pulada **incondicionalmente**,
mesmo com Postgres disponível. Passou despercebido porque o teste sentinela
("ambiente sem Postgres") só provava o caminho *sem* banco, nunca que o
caminho *com* banco de fato executava.

Corrigido para o padrão suportado: cada teste chama `t.skip(motivo)`
explicitamente no início, a partir do contexto de execução passado pelo test
runner. Verificado nas duas direções — com Postgres acessível, os 9 testes
reais rodam; apontando `TEST_DATABASE_URL` para um banco inexistente, os
mesmos 9 são pulados com o motivo correto.

## Ressalvas

1. **Sem TimescaleDB.** Ver acima — schema pronto para migração, extensão
   indisponível nesta bancada.
2. **Sem *continuous aggregates*.** Painéis que precisem de agregação em
   janela (ex.: taxa de detecção por hora) fazem `GROUP BY` direto; em escala
   de produção, isso é exatamente o que hypertables + continuous aggregates
   resolvem sem mudança de consulta.
3. **Escrita síncrona, sem *batching*.** Um evento por `INSERT`. Suficiente na
   cadência de bancada; a taxa de telemetria de uma frota completa em produção
   pode justificar *batching* por janela de tempo — otimização de throughput,
   não de corretude.
4. **`historian` é um sorvedouro passivo.** Nenhum caminho deste serviço
   decide nada sobre a circulação — um historiador fora do ar atrasa a
   auditoria, nunca a operação. Essa propriedade foi verificada por
   inspeção do código (o serviço só assina tópicos, nunca publica um comando),
   não por teste automatizado.
