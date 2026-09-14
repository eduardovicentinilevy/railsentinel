# Arquitetura Técnica — CCO de Próxima Geração, VLT da Baixada Santista

Fase 1 (Mês 1–12) — Middleware e Simulação, TRL 3→5.
Marco de saída: pacote `software-alpha` com barramento MQTT, algoritmos de ATS
e emulação NTCIP 1202 em malha fechada matematicamente estáveis.

---

## 1. Stack: linguagens, frameworks e alta disponibilidade

### 1.1 A decisão que precede a escolha da linguagem

A pergunta "que linguagem usar no backend do ATS" não tem resposta única, porque
o ATS não é um sistema — são três, com requisitos de certificação
incompatíveis entre si. A **EN 50716** obriga a separá-los, e essa separação
determina a linguagem antes de qualquer preferência de equipe.

| Camada | Função | Classe EN 50716 | Linguagem | Por quê |
|---|---|---|---|---|
| Núcleo vital | Intertravamento, autorização de rota, interface ATP | **SIL 4** | C/Ada SPARK, ou Rust com toolchain qualificado, sobre RTOS certificado (PikeOS, VxWorks 653) | Alocação estática, sem GC, sem heap dinâmico, verificação formal. **Não é este repositório** |
| Regulação ATS | Headway, dwell, despacho, TSP | **SIL 2 / Básica** | **Go** (produção) / **TypeScript** (Fase 1) | Concorrência por composição, latência previsível, binário estático |
| Middleware IIoT | Ponte de protocolo, normalização, GTFS-RT, IHM | **Básica** | **TypeScript/Node.js** | Ligado a E/S, não a CPU: 10⁴ conexões MQTT ociosas custam quase nada |
| Inferência de borda | Visão computacional no Jetson Orin | **Básica** | **Python + C++** (DeepStream/TensorRT) | O ecossistema segue o hardware |

**Recomendação honesta para a Fase 1:** TypeScript/Node.js em todo o middleware
e no ATS, Python na borda. É o que este repositório implementa.

O motivo não é que Node seja a melhor escolha para um regulador de tráfego — não
é. É que a Fase 1 valida **contratos de mensageria e estabilidade de algoritmo**,
não desempenho. Escrever o regulador em Go agora significaria pagar o custo de
uma linguagem a mais na equipe antes de saber se o algoritmo converge. Quando o
perfil de carga da Fase 2 mostrar onde a latência realmente dói, o laço de
regulação migra para Go com o contrato já congelado e testado — que é a parte
cara de acertar.

O erro a evitar é o oposto: escolher Node **também** para o núcleo vital porque
"o resto está em Node". Isso é indefensável numa auditoria SIL 4 e não deve ser
tentado.

### 1.2 Broker MQTT

**EMQX 5.x** (`docker-compose.yml`). Alternativa comercial: HiveMQ.

Mosquitto está descartado, apesar de ser o padrão de fato em bancada: não tem
clustering nativo. Um CCO não pode ter o barramento de telemetria como ponto
único de falha, e "rodar dois Mosquitto" não é cluster — é dois brokers com
estados divergentes.

O que decide por EMQX:

- **Erlang/OTP.** Árvores de supervisão e isolamento por processo são o modelo
  de concorrência da telefonia, projetado para degradar parcialmente em vez de
  cair inteiro. Um cliente malcomportado derruba o próprio processo, não o nó.
- **Cluster nativo** com *shared subscriptions* — escala horizontal de
  consumidores sem duplicar entrega.
- **mTLS com ACL por CN do certificado.** É o mecanismo que amarra identidade a
  tópico (§2.3) e sustenta a segmentação IEC 62443.
- **Hot code reload:** patch de segurança sem janela de manutenção. Numa
  operação 20h/dia, janela de parada é um custo real.

**Dois brokers, não um.** Campo (Zona Periférica) e núcleo (Zona de Integração)
são clusters distintos em VLANs distintas. O `ingest-gateway` é o único processo
com conexão aos dois — ele *é* o conduíte da IEC 62443. Rodar um broker só com
prefixos de tópico diferentes daria o mesmo diagrama e nenhuma das garantias: um
erro de ACL passaria despercebido, e o comprometimento do broker de campo
alcançaria o núcleo em um salto.

### 1.3 O que "alta disponibilidade" significa aqui

Este é o ponto onde arquiteturas de CCO costumam errar por importar reflexos de
sistemas web.

> **Rodar três réplicas do ATS não é alta disponibilidade — é uma falha de
> segurança.**

Três instâncias regulando a mesma linha emitem três ajustes de dwell conflitantes
para a mesma composição. O modo de falha não é indisponibilidade; é comando
incoerente, que é pior. Serviços de controle têm **escritor único por linha**.

| Componente | Padrão de HA | Justificativa |
|---|---|---|
| Broker MQTT | Cluster ativo/ativo (3 nós) + VIP keepalived | Mensageria é sem estado por conexão; escala horizontalmente |
| `ingest-gateway` | Ativo/ativo, N réplicas com *shared subscription* | Sem estado entre mensagens; o `ReplayGuard` tolera partição por origem |
| `ats-core` | **Ativo/standby com eleição de líder e fencing** | Escritor único obrigatório. Split-brain aqui gera comando conflitante |
| Historiador | TimescaleDB + Patroni (streaming replication) | RPO próximo de zero; failover automático |
| Estado quente | Valkey Sentinel ou NATS KV | Posição corrente da frota; reconstruível a partir do fluxo |
| `operator-api` | Ativo/ativo atrás de HAProxy | Somente leitura; projeção reconstruível |

Eleição de líder via **etcd/Raft**, com *lease* e **fencing token**: o líder
deposto perde a capacidade de escrever mesmo se ainda achar que é líder. Sem
fencing, um GC pause ou uma partição de rede produz dois líderes convencidos, que
é exatamente o cenário que a eleição deveria impedir.

**Meta de disponibilidade:** 99,95% na camada de supervisão. Note que o número
alto pertence ao núcleo vital SIL, que é redundante 2-de-3 em hardware e **não
depende deste stack** — a supervisão pode cair sem que a segurança da circulação
seja afetada. Essa é a consequência prática da partição EN 50716: ela limita o
que a indisponibilidade do software moderno pode causar.

### 1.4 Persistência e observabilidade

- **TimescaleDB** (PostgreSQL + hypertables) como historiador. Compressão nativa
  de séries temporais e *continuous aggregates* para os painéis; PostgreSQL puro
  degrada rápido com telemetria de 22 composições em alta taxa.
- **Object storage** (MinIO on-prem) para clipes de evidência, com ciclo de vida
  e retenção definidos — imagens de pedestres são dado pessoal sob a LGPD.
- **Prometheus + Grafana + Loki**, instrumentação via OpenTelemetry.
- **Trilha de auditoria imutável** (append-only, WORM) para violações de
  partição e recusas de fronteira. É a evidência exigida numa investigação de
  acidente ou numa auditoria de certificação.

---

## 2. Arquitetura de payloads: borda → CCO

Detalhamento completo em [`PAYLOADS.md`](./PAYLOADS.md). Os schemas normativos
estão em [`/schemas`](../schemas).

### 2.1 Envelope fixo + payload tipado

```jsonc
{
  "env": { /* envelope: pequeno, plano, sempre presente */ },
  "data": { /* payload tipado, selecionado por env.type */ },
  "sig": { /* assinatura destacada Ed25519 */ }
}
```

O envelope é deliberadamente plano e de tamanho limitado. Roteadores, ACLs e
filtros de zona decidem encaminhamento lendo só `env` — nunca desserializam
`data`. O custo de triagem fica constante e independente do tamanho do payload,
o que importa quando a fronteira está sob inundação.

### 2.2 Os três campos que fazem o trabalho pesado

**`env.class` — a partição EN 50716 in-band.** Todo evento originado de IA sai
carimbado `basic`. O `SafetyGuard` do `ats-core` (§3) usa essa marca para recusar
qualquer efeito vital. Sem a marca no dado, a partição viveria só na
documentação, e a documentação não é executável.

**`env.boot` — sessão de inicialização.** Contador de sequência sozinho não
distingue "o Jetson reiniciou e zerou o contador" de "alguém está reinjetando
tráfego antigo". Escolher entre bloquear um nó recém-reiniciado ou aceitar replay
não tem resposta boa. A saída é a mesma do `bdSeq` do **Sparkplug B**: `seq` é
monotônico *dentro* de uma sessão de boot; boot novo zera a contagem mas precisa
ser estritamente maior. Isto foi adicionado depois que a bancada produziu
rejeições falsas de replay a cada reinício do simulador — ver
`tests/contracts.test.ts`.

**`sig` — assinatura destacada.** mTLS autentica o salto até o broker; a
assinatura autentica a mensagem fim-a-fim, através de brokers e bridges. Cobre o
envelope *e* o payload, então adulterar `env.class` para escalar autoridade
invalida a assinatura (`tests/contracts.test.ts`).

### 2.3 O tópico é o modelo de autorização

```
vlt/{site}/{line}/{zone}/{srcKind}/{srcId}/{stream}[/{name}]
```

Cada nó recebe ACL de publicação restrita a `vlt/+/+/+/+/<seu-id>/#`. Como
`env.src` precisa casar com o CN do certificado, e o CN precisa casar com o
segmento do tópico, um nó comprometido não consegue forjar eventos de outro
cruzamento — a fraude fica contida ao próprio nó. A verificação é feita pelo
broker (ACL) *e* pelo gateway (`src_topic_mismatch`), porque defesa em
profundidade significa que nenhuma das duas é o único ponto de falha.

### 2.4 Teto de integridade — o controle que fecha o ciclo

`env.class` é **autodeclarado pelo dispositivo**. Sem verificação, um Jetson
comprometido carimbaria `sil4` nos próprios eventos e atravessaria o
`SafetyGuard`, que confia na classe para decidir autoridade.

Por isso o trust store registra `maxIntegrityClass` por dispositivo, e a
fronteira recusa qualquer reivindicação acima do teto homologado:

- `edge:jetson:*` → teto `basic` (visão computacional, sem homologação vital)
- `train:*` → teto `sil2` (odometria de bordo, rateada)

A marcação in-band só significa alguma coisa porque a fronteira a confere. Este
controle foi acrescentado depois de a revisão notar que o `ats-core` passava
`'sil2'` fixo no código ao avaliar TSP — o código afirmava uma classe que o dado
não carregava. Cobertura em `tests/admission.test.ts`.

### 2.5 Pipeline de admissão: a ordem é orçamento de CPU sob ataque

```
tamanho → JSON → schema → amarração src/tópico → autorização
        → teto de integridade → assinatura → frescor/replay
```

As checagens baratas e seletivas vêm primeiro. Verificar assinatura antes do
schema seria o erro clássico: gastaria uma verificação Ed25519 em cada pacote
malformado que chegasse — exatamente o que um atacante enviaria em volume.
Travado por teste (`ordem do pipeline: schema barra antes da criptografia`).

### 2.6 Quando JSON deixa de servir

JSON é a escolha certa para **eventos** — um alerta de invasão tem ~700 bytes,
alguns por hora por nó, e a depurabilidade em campo vale mais que os bytes.

JSON é a escolha errada para **telemetria de alta taxa**. 22 composições a 5 Hz
com 15 campos é ~1,3 MB/min só de nomes de chave repetidos, sobre rádio
compartilhado. A migração é **CBOR** (RFC 8949) — mesmo modelo de dados, mesmo
JSON Schema, sem mudar código de domínio — ou Protobuf quando o esquema estiver
estável. Os schemas em `/schemas` continuam sendo a fonte da verdade nos dois
casos.

### 2.7 Segurança do canal

| Camada | Mecanismo |
|---|---|
| Transporte | mTLS 1.3, X.509 de vida curta, matrícula via EST (RFC 7030) |
| Chave privada | Gerada no Secure Element/TPM do Orin, **não extraível** |
| Rotação | Mensal, `kid` = `<id>:<época>`, sobreposição de janela |
| Mensagem | Ed25519 destacada sobre serialização canônica (RFC 8785) |
| Anti-replay | Janela de frescor + sessão de boot + seq + cache de ids |
| Relógio | NTP autenticado (NTS) ou PTP — dwell e headway são cálculos temporais |
| Autorização | ACL por CN + zona + tipo + teto de integridade |
| Vazão | Limite por dispositivo, com recusa auditada |

**Pós-quântico:** o documento de projeto prevê criptografia PQ nos enlaces de
rádio. A recomendação prática é *não* adotar agora, e sim garantir agilidade
criptográfica — `sig.alg` é um campo justamente para permitir migrar para
ML-DSA (FIPS 204) sem quebrar o contrato. Ed25519 hoje, com caminho de saída
pronto, é melhor postura que uma stack PQ imatura em infraestrutura crítica.

---

## 3. Partição EN 50716 executável

O `SafetyGuard` (`services/ats-core/src/safety-guard.ts`) é o único caminho pelo
qual o ATS produz efeito. Regra: **a autoridade de um efeito nunca pode exceder a
classe de integridade da evidência que o motivou.**

| Evidência | Pode | Não pode |
|---|---|---|
| `basic` (IA) | Alarme, restrição *advisory*, **retirar** prioridade, ajustar dwell, alerta GTFS | Freio, rota, liberação de travamento, **conceder** prioridade, sobrepor ATP |
| `sil2` | Tudo acima + conceder prioridade semafórica | Freio, intertravamento |
| `sil4` | Autoridade plena | — |

O ponto sutil é a assimetria do TSP. **Retirar** um pedido de prioridade é
permitido à Integridade Básica porque só remove uma ação permissiva: o pior caso
de uma retirada equivocada é um VLT parando num sinal que poderia estar verde —
perda de desempenho, nunca de segurança. **Conceder** cria permissão, e por isso
fica fora do alcance da IA.

Toda tentativa barrada é registrada com justificativa e id do evento de origem.
Numa auditoria, "o código não faz isso" é afirmação fraca; "existe um ponto único
que recusa e registra toda tentativa, e aqui estão os 12 testes que a exercitam"
é evidência.

---

## 4. Regulação de headway: por que o setpoint não é o quadro de horários

Controle PI sobre o erro de headway, sem termo derivativo — a medida vem de
telemetria com jitter de rádio, e derivada de sinal ruidoso produz comandos de
dwell oscilantes, desconfortáveis ao passageiro e desgastantes ao material
rodante.

Duas restrições ficam **fora da malha**, como *clamp*, porque não são parâmetros
de sintonia:

- `DWELL_MIN_S = 20s` — piso de acessibilidade do embarque 100% em nível na
  plataforma de 30 cm. Nenhum ganho de pontualidade justifica fechar porta em
  cima de um passageiro com mobilidade reduzida.
- `COAST_MAX_PCT = 8%` — acima disso a variação de velocidade vira solavanco.

**O setpoint é ciclo/N, não o número do quadro.** Num circuito fechado, N
composições só sustentam um espaçamento: ciclo/N. Não é escolha, é geometria.
Perseguir o valor do quadro quando ele diverge disso satura dwell e coasting em
todos os trens ao mesmo tempo sem nunca convergir — o que na operação aparece
disfarçado de "o controlador está mal sintonizado" quando o problema real é
dimensionamento de frota.

Isso apareceu na bancada: com 3 composições e alvo de 1200 s, todos os trens
saturavam em `dwell 90s + coasting 8%` com erro de −955 s. A correção foi
regular por ciclo/N e reportar a divergência como **sinal de planejamento**, com
o número de composições necessárias para fechar a diferença.

---

## 5. TSP adaptativo (NTCIP 1202)

O CCO atua como *Priority Request Server*. As três estratégias da norma —
`phase_call`, `green_extension`, `red_truncation` — são selecionadas por ETA.

O que torna o esquema **adaptativo** é o portão de elegibilidade: só se pede
prioridade para composição **atrasada** (limiar de 45 s). Um VLT adiantado que
recebe onda verde chega ainda mais cedo, o que não melhora pontualidade e apenas
transfere atraso ao tráfego transversal — que inclui as linhas municipais de
ônibus.

Prioridade concedida sem critério degrada a rede inteira e queima o acordo
político com a CET-Santos, que é o ativo mais difícil de recuperar num projeto
destes. O portão existe tanto por engenharia de tráfego quanto por viabilidade
institucional.

---

## 6. Fail-visible: ausência de alerta não é prova de via livre

O modo de falha mais perigoso de um sistema de detecção é o silêncio
interpretado como "tudo bem".

- Todo nó publica heartbeat e registra **LWT** (Last Will and Testament) no
  broker. Se o nó cair, o broker publica `status: offline` por conta própria.
- O `ats-core` converte `offline`/`fault` em alarme de **perda de cobertura**,
  com texto explícito ao operador de que o trecho deixou de ter detecção
  automática.
- Um `cleared` vindo da borda **nunca** levanta a restrição sozinho: marca a
  ocorrência como candidata, e o operador confirma. Fosse automático, um único
  `cleared` forjado — ou um falso negativo do modelo — reabriria uma via ainda
  obstruída.

---

## 7. Limites conhecidos desta fase

Ditos explicitamente, porque um documento de arquitetura que só lista virtudes
não é útil para planejar a Fase 2:

1. **O núcleo vital SIL 4 não existe aqui, por construção.** Este repositório é
   inteiro de Integridade Básica. Intertravamento e ATP são hardware/software
   certificado separado, na Zona Interna Vital.
2. **Sem persistência.** O estado vive em memória; reinício perde o histórico. A
   Fase 2 traz TimescaleDB e barramento durável (NATS JetStream ou Kafka).
3. **`ats-core` é instância única.** A eleição de líder com fencing descrita em
   §1.3 está especificada, não implementada.
4. **NTCIP 1202 é emitido, não transportado.** Os objetos MIB são gerados
   corretamente, mas não há camada SNMP — a Fase 1 fecha o laço contra emulador
   (HIL), conforme o roadmap.
5. **mTLS não está ativo na bancada.** A autenticação por assinatura Ed25519
   está; o certificado de transporte entra com a PKI da Fase 2.
6. **Modelo de topologia estático.** Substituído na Fase 2 pelo modelo importado
   do sistema de intertravamento, atrás da mesma interface.
