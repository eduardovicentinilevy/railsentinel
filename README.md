# RailSentinel

Middleware IIoT e ATS para o Centro de Controle Operacional de próxima geração
do **VLT da Baixada Santista**.

**Fase 1 — Middleware e Simulação (TRL 3→5).** Bancada executável do barramento
de mensageria, dos algoritmos de supervisão e da partição de segurança
normativa, conforme o roadmap do projeto.

---

## O problema

A Linha 2 do VLT roda em via nivelada com o leito carroçável pelo Centro
Histórico de Santos, dividindo cruzamentos com pedestres e automóveis em ruas
como Campos Mello, João Pessoa e Amador Bueno. Circuitos de via e linha de visão
do condutor não bastam nesse ambiente.

A resposta é detecção por visão computacional na borda — e ela traz um problema
normativo imediato: **um modelo de IA não pode ter autoridade sobre funções
vitais**. A CENELEC EN 50716 permite a convivência, desde que a segregação seja
demonstrável.

Este repositório trata essa segregação como requisito de implementação, não de
documentação.

## O que está implementado

| Componente | Descrição |
|---|---|
| `packages/contracts` | Envelope, JSON Schemas, JSON canônico (RFC 8785), Ed25519, ACL de tópicos, anti-replay com sessão de boot |
| `services/ingest-gateway` | Conduíte IEC 62443 — único processo nas zonas de campo e de núcleo |
| `services/ats-core` | SafetyGuard (EN 50716), regulação de headway, TSP NTCIP 1202, tratamento de invasão |
| `services/operator-api` | Projeção de estado, IHM via SSE, exportador GTFS Realtime |
| `edge/jetson_sim` | Simulador de nó NVIDIA Jetson Orin (Python), com cenários de ataque |
| `tests/` | 90 testes — partição de segurança, admissão de fronteira, contratos |

## Início rápido

```bash
npm install && npm run build && npm run keys
python3 -m venv .venv && .venv/bin/pip install -r edge/jetson_sim/requirements.txt

# 4 terminais
npm run brokers    # 1883 campo · 1884 núcleo
npm run gateway
npm run ats
npm run operator   # http://localhost:8080

npm run sim        # dispara o cenário de invasão de via
```

Passo a passo completo em [`docs/RUNBOOK.md`](docs/RUNBOOK.md).

## Fluxo: da detecção ao painel do operador

```
Jetson Orin (rua)                          CCO (Macuco)
─────────────────                          ────────────
detecção YOLO
  │
  ├─ metadados apenas (~700 B)   ─┐
  ├─ assinatura Ed25519            │  broker de campo
  └─ carimbo class: "basic"       ─┘  (Zona Periférica)
                                        │
                              ingest-gateway  ◄── CONDUÍTE
                                        │       tamanho → JSON → schema
                                        │       → identidade → autorização
                                        │       → teto de integridade
                                        │       → assinatura → frescor
                                        ▼
                              barramento do núcleo
                                        │
                                   ats-core
                                        │
              ┌─────────────────────────┼──────────────────────┐
              ▼                         ▼                      ▼
      alarme ao operador        restrição advisory      TSP suspenso
      (com proveniência         (exige confirmação      a montante
       do modelo)                humana)                (ação de remoção)
              │                         │                      │
              └─────────────────────────┴──────────────────────┘
                                        ▼
                          IHM (SSE) + GTFS-RT ao passageiro
```

Nada nesse caminho comanda freio. O que o sistema faz é reduzir o tempo de
reação **humana** de dezenas de segundos para menos de um, e retirar prioridade
semafórica — uma ação que só remove permissão e é segura mesmo se o modelo
estiver errado.

## Três decisões que definem a arquitetura

**A classe de integridade viaja no dado, e tem teto.** Todo evento de IA sai
carimbado `basic`. O `SafetyGuard` recusa efeitos vitais a partir dessa marca. E
como a marca é autodeclarada, a fronteira a confere contra a homologação
registrada do dispositivo — um Jetson comprometido não consegue reivindicar
`sil4`.

**Retirar prioridade é permitido à IA; conceder não é.** Retirar só remove uma
ação permissiva: o pior caso é um VLT parando num sinal que poderia estar verde.
Conceder cria permissão. A assimetria é o que permite à visão computacional agir
de forma útil sem adquirir autoridade vital.

**Ausência de alerta não é prova de via livre.** Heartbeat, LWT no broker, e
alarme explícito de perda de cobertura quando um nó silencia. Um `cleared` da
borda nunca reabre a via sozinho — só a confirmação do operador.

## Documentação

| Documento | Conteúdo |
|---|---|
| [`ARQUITETURA.md`](docs/ARQUITETURA.md) | Stack, alta disponibilidade, payloads, partição EN 50716, limites conhecidos |
| [`PAYLOADS.md`](docs/PAYLOADS.md) | Contrato de mensageria, tópicos, assinatura, filtros |
| [`SEGURANCA.md`](docs/SEGURANCA.md) | Zonas IEC 62443, superfície de ataque, LGPD |
| [`RUNBOOK.md`](docs/RUNBOOK.md) | Execução, cenários, diagnóstico |

## Escopo

Este repositório é **inteiramente de Integridade Básica** (EN 50716). O núcleo
vital SIL 2/4 — intertravamento, autorização de rota, interface ATP — é
hardware e software certificados à parte, na Zona Interna Vital, e não faz parte
deste código por construção.

Os limites conhecidos desta fase estão listados em
[`ARQUITETURA.md §7`](docs/ARQUITETURA.md#7-limites-conhecidos-desta-fase).

## Normas de referência

CENELEC EN 50716 (software ferroviário) · EN 50126 (RAMS) · IEC 62443
(cibersegurança IACS) · NTCIP 1202 v03/v04 (controladores semafóricos) ·
GTFS Realtime 2.0 · RFC 8785 (JSON canônico) · RFC 7030 (EST)
