# Estabilidade — Evidência da Fase 1

Reproduzir: `npm run stability` · `.venv/bin/python edge/jetson_sim/bench_vision.py`
Relatórios: `estabilidade-report.json` · `visao-report.json`

---

## 1. Regulação de headway

### 1.1 O erro que a análise inicial cometeu

A primeira versão deste banco modelava cada par de composições isoladamente
(`e⁺ = e − u`) e concluiu ρ = 0,866 — "estável". A simulação empírica então
mostrou o controlador **piorando** o sistema: erro RMS de 150 s em malha
fechada contra 70 s em malha aberta.

A discrepância expôs o erro do modelo. Num circuito fechado os headways não são
independentes. Segurar o trem *i* por Δ segundos aumenta o intervalo de *i* para
o da frente, mas **reduz na mesma medida** o intervalo do trem de trás para *i*:

```
e⁺ = e + (I − S)·Δ          S = deslocamento circular
```

A soma dos headways é o tempo de ciclo, constante — por isso `(I − S)` tem
autovalor nulo na direção uniforme, que o controlador não pode nem precisa
corrigir. Diagonalizando por Fourier, cada modo *k* tem ganho λₖ = 1 − ωᵏ:

| modo | λ | \|λ\| |
|---|---|---|
| k=0 (uniforme) | 0 | 0 — não controlável |
| k=1 | 1,500 − 0,866i | **1,732** |
| k=2 | 1,500 + 0,866i | **1,732** |

O ganho efetivo da malha é **√3 ≈ 1,73× maior** do que o modelo isolado supunha.

### 1.2 Resultado

Por modo, o sistema de 2ª ordem:

```
e⁺ = (1 − λₖ·Kp)·e − λₖ·I
I⁺ = Ki·T·(1 − λₖ·Kp)·e + (1 − Ki·T·λₖ)·I
```

| ganhos | ρ | veredito |
|---|---|---|
| Kp=0,25 Ki=0,020 (originais, por intuição) | **0,974** | estável no papel, sem margem |
| Kp=0,51 Ki=0,017 (sintonizados) | **0,708** | ✅ margem de ganho 1,72× |

Acomodação a 2%: ≈ 113 s analítico. Os ganhos originais estavam a 2,6% da
instabilidade — e empiricamente já degradavam, porque a saturação de dwell
consome a margem que o modelo linear não vê.

### 1.3 Simulação empírica — dois regimes

Planta real, relógio virtual, 2 h de operação, 8 sementes, perturbação de 90 s
em t=1200 s.

**Regime A — ruído de embarque contínuo (condição real):**

| | sem controle | Kp=0,25 | Kp=0,51 |
|---|---|---|---|
| erro RMS de headway | 70 s | 150 s | **38 s** |
| divergiu | 0/8 | 0/8 | 0/8 |
| acomodou (RMS<30 s) | 1/8 | 0/8 | **7/8** |
| tempo de acomodação | — | — | 1580 s |

**Regime B — impulso isolado, sem variabilidade posterior:**

| | sem controle | Kp=0,51 |
|---|---|---|
| erro RMS de headway | 58 s | 60 s |

No Regime B o regulador **não melhora nem piora** de forma material. Não há
perturbação recorrente a rejeitar, e o custo de atuar iguala o ganho. Reportar
apenas o Regime A superestimaria o benefício, e por isso o banco e o teste de
regressão cobrem os dois.

### 1.4 Bug encontrado: medição e setpoint em bases diferentes

O headway medido usava apenas distância/velocidade; o setpoint (ciclo/N) incluía
os dwells. Diferença sistemática de **210 s na L2** — o dwell total da linha.
Consequência: mesmo com as composições perfeitamente espaçadas o erro nunca
zerava, o controlador segurava as três no dwell máximo e o desvio de tabela
divergia.

Corrigido em `traversalTimeS()`: o headway é separação **temporal**, e tempo
entre dois trens inclui o tempo parado. Viés médio caiu de −71 s para −11 s.

Consequência secundária: espaçamento temporal uniforme **não** é espaçamento em
distância uniforme, porque as seções têm velocidades de via diferentes. O
controlador equaliza tempo — que é o que o passageiro na plataforma sente.

### 1.5 Restrições invioláveis

| restrição | violações em 8×2 h |
|---|---|
| piso de dwell (acessibilidade, 20 s) | **0** |
| teto de coasting (8%) | **0** |

O piso é aplicado **duas vezes**: pelo controlador e, independentemente, pelo
computador de bordo (`packages/plant`). O CCO aconselha; o bordo nunca fecha
porta antes do mínimo, venha o comando de onde vier.

---

## 2. TSP em malha fechada (HIL NTCIP 1202)

O emulador (`services/ntcip-emulator`) implementa uma máquina de estados
anel-e-barreira com as restrições que a norma expõe como objetos MIB: verde
mínimo, amarelo, vermelho-geral e verde máximo.

**O valor do emulador está nas recusas.** Um controlador que concedesse toda
prioridade pedida faria o TSP parecer perfeito na bancada e falhar em campo:

- `verde maximo ja atingido` — protege o movimento transversal da fome
- `extensao pedida com a fase do VLT fora de verde` — pedido mal formulado
- force-off só atua **depois** do verde mínimo — pedestre não fica na faixa

Duas defesas contra oscilação, ambas exercitadas por teste:

1. **Debounce de pedido em voo.** Reemitir a cada atualização de posição (1 Hz)
   reescreveria a chamada de fase continuamente e o controlador nunca concluiria
   a transição.
2. **Realimentação de verde iminente.** Se o controlador já vai dar verde a
   tempo, não se pede nada — prioridade que não muda o resultado só gasta
   crédito político com o órgão de trânsito.

A estratégia (`phase_call` / `green_extension` / `red_truncation`) é escolhida
pelo **estado real** do controlador, não só pelo ETA: pedir extensão de verde
com a fase em vermelho é uma recusa evitável.

---

## 3. Pipeline de inferência de borda

| métrica | resultado | critério |
|---|---|---|
| latência p95 da cadeia | **4,1 ms** | < 33 ms (30 fps) ✅ |
| taxa sustentável no p95 | 245 fps | ≥ 30 fps ✅ |
| erro lateral mediano | **3,0 cm** | — |
| erro lateral p95 | **7,3 cm** | < 40,6 cm (25% da meia-largura) ✅ |
| atraso de detecção da invasão | 0 quadros | ≤ 15 quadros ✅ |
| falsos positivos (controle negativo) | **0** | 0 ✅ |

### 3.1 Bug encontrado: geometria avaliada sobre trilha obsoleta

O erro lateral p95 estava em **48,1 cm** contra mediano de 3,6 cm. A cauda vinha
dos quadros 4–9, onde a posição medida congelava em 4,14 m enquanto o objeto se
movia.

Causa: o `Tracker` mantém trilhas não observadas por alguns quadros, para
preservar o id através de oclusão curta — e o pipeline avaliava a **caixa
antiga** dessas trilhas. Isso reporta a posição que o objeto ocupava, não a que
ocupa. Numa detecção de invasão é o pior tipo de erro: o alerta sai com
coordenada desatualizada e o operador procura o obstáculo no lugar errado.

Corrigido: só trilhas observadas no quadro corrente são avaliadas
geometricamente; a continuidade de id segue valendo para a persistência. Erro
p95 caiu para **7,3 cm**.

### 3.2 O que a geometria resolve e o detector não

O detector diz "há um automóvel no quadro". Isso não é útil. O CCO precisa saber
se o objeto está **dentro do gabarito dinâmico** (2,65 m de caixa + 0,30 m de
envoltória por lado = meia-largura de 1,625 m) e a que distância lateral do eixo
— e isso é homografia, não aprendizado.

Duas decisões que o teste trava:

- **Projeta-se a base da caixa, não o centro.** Só o contato com o solo tem
  projeção válida; projetar o centro de um objeto alto o afasta
  sistematicamente, e num caminhão o erro chega a metros.
- **Mede-se a borda mais próxima do eixo, não o centro.** Um caminhão cujo
  centro está fora do gabarito mas cuja lateral invade continua sendo colisão.

---

## 4. Ressalvas

Ditas explicitamente, porque uma evidência de estabilidade sem limites
declarados não é utilizável numa auditoria.

1. **A análise modal é válida na região não saturada.** Saturação de dwell,
   piso de acessibilidade e anti-windup são não linearidades que a linearização
   não cobre — daí a simulação empírica ao lado, e não no lugar.
2. **O regime de operação importa.** O ganho de 45% vale sob variabilidade
   contínua de embarque. Sob impulso isolado há paridade, não ganho.
3. **A cena de visão é sintética.** Iluminação, chuva, contraluz da orla,
   textura de pavimento e oclusão real só se validam com dado de campo. O que
   se validou aqui é a **cadeia geométrica**, que transfere; os pesos do
   detector, não.
4. **O backend medido é clássico** (subtração de fundo), não TensorRT no Orin. A
   latência de 4 ms não representa o alvo embarcado; o caminho ONNX existe e é
   ativado por `RAILSENTINEL_ONNX_MODEL`, mas exige modelo treinado no domínio.
5. **Três composições.** A análise modal generaliza para N, mas os números
   empíricos são da L2 com a frota atual. Frota diferente exige nova varredura.
6. **O HIL é software.** Hardware-in-the-loop com o controlador físico da
   CET-Santos é Fase 2, assim como o transporte SNMPv3 autenticado.
