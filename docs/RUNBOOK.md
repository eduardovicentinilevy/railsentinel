# Runbook — Bancada da Fase 1

## Pré-requisitos

Node.js ≥ 22, Python ≥ 3.11. Docker é opcional (há brokers embutidos para
desenvolvimento).

## Preparação

```bash
npm install
npm run build
npm run keys          # matricula os nós, gera .secrets/

python3 -m venv .venv
.venv/bin/pip install -r edge/jetson_sim/requirements.txt
```

## Pré-requisitos da Fase 2

```bash
npm run setup-pki      # gera a PKI interna (mTLS) em .secrets/pki/
npm run db:migrate     # aplica db/schema.sql no PostgreSQL local
```

`db:migrate` espera um PostgreSQL acessível em
`postgres://railsentinel:railsentinel_dev@127.0.0.1:5432/railsentinel`
(ajustável via `DATABASE_URL`). Criar a role e o banco uma vez:

```bash
sudo -u postgres psql -c "CREATE ROLE railsentinel WITH LOGIN PASSWORD 'railsentinel_dev' CREATEDB;"
sudo -u postgres psql -c "CREATE DATABASE railsentinel OWNER railsentinel;"
sudo -u postgres psql -c "CREATE DATABASE railsentinel_test OWNER railsentinel;"  # para os testes
```

## Execução (6 terminais)

```bash
npm run brokers        # 1883 campo · 8883 campo mTLS (se PKI presente) · 1884 núcleo
npm run gateway        # conduíte IEC 62443 (ascendente + descendente, mTLS se disponível)
npm run ats            # ATS (Integridade Básica)
npm run ntcip          # HIL: 5 controladores semafóricos emulados
npm run historian      # grava o barramento do núcleo no PostgreSQL
npm run operator       # IHM em http://localhost:8080
```

Frota em malha fechada (consome os comandos de regulação do CCO):

```bash
npm run fleet
```

## Bancos de evidência

```bash
npm run stability                                   # análise modal + simulação
.venv/bin/python edge/jetson_sim/bench_vision.py    # pipeline de inferência
```

## Cenários

```bash
npm run sim                                                        # invasão (sintética)
.venv/bin/python edge/jetson_sim/edge_node.py --scenario vision    # pipeline real sobre pixels
.venv/bin/python edge/jetson_sim/edge_node.py --scenario degraded  # fail-visible
.venv/bin/python edge/jetson_sim/edge_node.py --scenario spoof     # falsificação
.venv/bin/python edge/jetson_sim/edge_node.py --scenario loop      # contínuo
```

### O que observar

**`intrusion`** — dois eventos são filtrados antes de virar alarme (confiança
baixa; persistência de 1 quadro), um vira incidente crítico com restrição
`advisory_hold` e suspensão de TSP em dois cruzamentos, e o `cleared` **não**
libera a via. A liberação só ocorre pelo botão na IHM, com matrícula do operador.

**`degraded`** — o nó passa a `degraded` e depois `fault`. A IHM levanta alarme
de perda de cobertura com o texto "ausência de alerta não significa via livre".

**`spoof`** — quatro tentativas, quatro recusas na fronteira:
`missing_signature`, `bad_signature`, `src_topic_mismatch`, `duplicate`.
Visíveis no painel de auditoria da IHM.

## Endpoints

| Rota | Descrição |
|---|---|
| `GET /` | IHM do operador |
| `GET /api/state` | Estado consolidado (JSON) |
| `GET /api/stream` | SSE — a IHM não faz polling |
| `GET /api/gtfs-rt` | Feed GTFS Realtime |
| `POST /api/clear-section` | Liberação de seção (exige `operator_id`) |
| `GET /healthz` | Saúde do serviço |

## Testes

```bash
npm test                                              # 117 testes (TypeScript)
.venv/bin/python edge/jetson_sim/test_vision.py       # 16 testes (pipeline de visão)
```

Cobertura por área: serialização canônica e assinatura, validação de schema,
anti-replay com sessão de boot, ACL de tópico, partição EN 50716, fluxo de
invasão, portão adaptativo de TSP, regulação de headway, admissão na fronteira.

## Docker

```bash
npm run keys
docker compose up --build
```

Sobe EMQX em duas redes separadas. O `ingest-gateway` é o único container nas
duas — a segmentação IEC 62443 é imposta pela topologia de rede, não por
configuração de aplicação.

## Diagnóstico

**Gateway recusa tudo com `unknown_device`** — rode `npm run keys`, ou confira
`DEVICE_REGISTRY`.

**`schema: envelope/env must have required property 'boot'`** — mensagem retida
de uma versão anterior do contrato. Reinicie os brokers.

**Nenhum comando de regulação** — são necessárias ao menos 2 composições não
obsoletas na mesma linha. Rode `npm run fleet`.

**TSP nunca concede** — verifique `schedule_dev_s ≥ 45` e que o cruzamento não
está inibido por incidente aberto.
