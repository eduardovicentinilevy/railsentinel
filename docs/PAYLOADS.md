# Contrato de Payloads — Borda ↔ CCO

Schemas normativos em [`/schemas`](../schemas). Este documento explica as
decisões; os schemas são a fonte da verdade.

---

## Estrutura

```jsonc
{
  "env":  { /* envelope fixo, plano, sempre presente */ },
  "data": { /* payload tipado por env.type */ },
  "sig":  { /* assinatura destacada Ed25519 */ }
}
```

## Envelope

| Campo | Tipo | Papel |
|---|---|---|
| `v` | `1` | Versão do envelope |
| `id` | UUIDv7 | Idempotência; ordenável por tempo |
| `seq` | int | Monotônico **dentro da sessão de boot** |
| `boot` | int | Sessão de inicialização (epoch ms) — ver abaixo |
| `ts` | RFC3339 UTC ms | Relógio da origem. Fuso local é **recusado** |
| `src` | `kind:platform:ID` | Identidade; casa com o CN do certificado |
| `site` / `line` / `zone` | enum/string | Roteamento e ACL |
| `type` | `vlt.<dom>.<nome>.v<N>` | Seleciona o schema de `data` |
| `class` | `basic\|sil2\|sil4` | Partição EN 50716, verificada contra o teto |
| `sev` | `info\|warning\|major\|critical` | Triagem na IHM |
| `corr` | string | Correlaciona evento → decisão → comando |

### Por que `boot` existe

Um nó que reinicia zera `seq`. Um guard que só observa `seq` não distingue
reinício legítimo de replay, e ambas as respostas possíveis são ruins: bloquear
um Jetson recém-reiniciado, ou aceitar tráfego reinjetado.

`boot` resolve pela mesma via do `bdSeq` do **Sparkplug B**:

| Situação | Veredito |
|---|---|
| `boot` maior que o último visto | Reinício legítimo — contagem reiniciada |
| `boot` igual | `seq` precisa avançar |
| `boot` menor | Sessão antiga reinjetada — **recusado** |

Adicionado depois que a bancada gerou rejeições falsas de replay a cada
reinício do simulador. O sintoma foi observado, não previsto.

### Por que `class` viaja no dado

A partição EN 50716 precisa ser verificável em runtime e auditável em log, não
apenas descrita em documento. `class` acompanha a mensagem até o `SafetyGuard`,
que decide autoridade a partir dela.

**Autodeclarado ⇒ precisa de teto.** O trust store registra
`maxIntegrityClass` por dispositivo e a fronteira recusa reivindicação acima
dele. Um nó de visão não consegue carimbar `sil4` nos próprios eventos.

## Assinatura

Ed25519 destacada sobre `canonicalize({env, data})` — JCS (RFC 8785).

Canonicalizar antes de assinar elimina uma classe inteira de bug: sem ordem
determinística de chaves, dois processos serializam o mesmo objeto de formas
diferentes e a verificação falha por motivo que nada tem a ver com segurança.

A assinatura cobre envelope **e** payload. Adulterar `env.class` para escalar
autoridade invalida a assinatura.

Ed25519 e não ECDSA: é determinístico (sem dependência de RNG no momento da
assinatura, o que importa em embarcado) e assina em dezenas de microssegundos no
Orin.

> As implementações canônicas em TypeScript (`packages/contracts/src/canonical.ts`)
> e Python (`edge/jetson_sim/edge_node.py`) precisam concordar byte a byte. Se
> divergirem em uma vírgula, toda verificação falha. Os testes de
> interoperabilidade existem para travar esse acoplamento.

## Tópicos

```
vlt/{site}/{line}/{zone}/{srcKind}/{srcId}/{stream}[/{name}]
```

`stream`: `tlm` (telemetria) · `evt` (evento) · `hb` (heartbeat/LWT) · `cmd` (comando)

ACL por dispositivo:

```
publicação:  vlt/+/+/+/+/<id>/#
assinatura:  vlt/+/+/+/+/<id>/cmd/#
```

Barramento do núcleo (`core/...`) é broker separado, alcançável só pelo
`ingest-gateway`.

## Tipos de payload

### `vlt.edge.intrusion.v1`

Apenas metadados — **nenhum quadro de vídeo trafega**.

```jsonc
{
  "event": "gauge_intrusion",
  "state": "onset",                    // onset | sustained | cleared
  "object":   { "class": "car", "conf": 0.94, "track_id": "t-771" },
  "geo":      { "lat": -23.9618, "lon": -46.3322, "accuracy_m": 2.5 },
  "track":    { "section_id": "L2-S11", "chainage_m": 640, "gauge_margin_m": -0.35 },
  "detector": { "model": "railguard-yolo", "model_version": "3.2.1", "infer_ms": 11.4 },
  "evidence": { "ref": "edge://XC-ANA-COSTA-01/clips/018f…", "retrieval": "pull", "redacted": true },
  "dwell_ms": 2400
}
```

**`detector`** carrega proveniência do modelo. Uma investigação de acidente ou
uma auditoria da ARTESP vai perguntar qual versão tomou a decisão; sem isso o
evento não é auditável. A IHM exibe esses campos ao lado do alarme para que o
operador saiba o peso probatório do que está vendo.

**`evidence`** é ponteiro, modelo *pull*. O clipe fica no Orin com faces já
borradas e o CCO busca só se o operador pedir. Preserva banda de rádio e atende
à LGPD por minimização — imagens de pedestres em via pública são dado pessoal.

**`gauge_margin_m`** negativo significa que o objeto já está dentro do gabarito
dinâmico. É o campo que dispara o tratamento urgente, que ignora o filtro de
persistência.

### `vlt.edge.health.v1`

Heartbeat e payload do **LWT**. Uma câmera muda precisa aparecer como degradada,
nunca como "nenhuma invasão detectada".

### `vlt.train.position.v1`

Telemetria de posição da Tramlink V4. `schedule_dev_s` negativo = adiantado. É a
entrada primária do regulador de headway e do portão de TSP.

Alta taxa: candidato natural à migração para CBOR (§2.6 de `ARQUITETURA.md`).

## Filtros aplicados no `ats-core`

**Confiança ponderada pela consequência**, não pela acurácia média do modelo:

| Classe | Limiar | Razão |
|---|---|---|
| `person` | 0,45 | Falso negativo é incomparavelmente pior que falso positivo |
| `bicycle` | 0,50 | |
| `car` / `truck` | 0,60 | |
| `debris` | 0,70 | Falso positivo interrompe circulação sem necessidade |
| `unknown` | 0,75 | |

**Persistência mínima** de 400 ms descarta detecção de quadro isolado — mas é
pulada quando há urgência (pessoa na via, ou objeto já dentro do gabarito). O
`state: cleared` também escapa do filtro: chega com `dwell_ms = 0` por natureza,
e tratá-lo como transitório descartaria silenciosamente a única pista de que a
via pode ter normalizado.

## QoS e retenção

| Fluxo | QoS | Retain |
|---|---|---|
| Evento de invasão | 1 | não |
| Heartbeat / LWT | 1 | **sim** |
| Telemetria de posição | 0 | não |
| Restrição de via | 1 | **sim** |
| Estado do sistema | 0 | **sim** |

QoS 1 entrega ao menos uma vez: duplicata é comportamento normal, não ataque —
por isso a deduplicação por `id` vem antes de qualquer suspeita, e a auditoria
registra `duplicate` em vez de rotular reentrega de rádio como incidente de
segurança.

Retain nos tópicos de estado garante que um serviço que sobe encontre o mundo
como está, sem esperar o próximo ciclo.
