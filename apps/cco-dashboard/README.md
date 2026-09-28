# Painel do CCO (React)

Painel do operador do CCO do VLT da Baixada Santista, em React + TypeScript,
com identidade visual do brasão de Santos e dados mockados.

```bash
npm install            # na raiz do repositório (workspaces)
npm run dashboard      # http://localhost:5173
npm run dashboard:build  # gera apps/cco-dashboard/dist/, abre direto do disco
```

## O que o operador faz nesta tela

| Função | Comportamento |
|---|---|
| **Posto de operação** | Operador identificado no topo. Sem operador, todo comando fica bloqueado. Troca de turno registra saída e entrada. |
| **Alarmes** | Não reconhecidos ficam no topo, com faixa de severidade pulsante. *Reconhecer* carimba operador e horário. As ações previstas de cada alarme (CFTV, avisar condutores, chamado de manutenção) vão para o registro. |
| **Restrição de via** | Liberação em dois passos: *Confirmar liberação…* e depois a matrícula digitada, que precisa ser a do operador do posto. Nunca por clique único. |
| **Linha 2 ao vivo** | Composições avançam no esquema (Pausa / 1× / 10×). Uma composição **para antes** de uma seção com restrição ativa e acumula atraso; as seguintes mantêm distância mínima atrás dela. Liberada a seção, a marcha é retomada. |
| **Frota** | Seção, próxima parada, desvio de tabela, lotação, estado e TSP por composição. Clicar numa linha (ou no trem do esquema) destaca a composição no esquema e no gráfico. *Rádio* registra chamada ao condutor. |
| **Desvio de tabela** | 40 min de histórico; o último ponto é o desvio ao vivo. Hover mostra os valores. |
| **Registro do turno** | Todo evento de sistema e todo comando, com operador e horário, mais recente primeiro. |
| **Tema** | Sistema / diurno / noturno, lembrado por posto (`localStorage`). |

Para ver o ciclo completo em ~1 min: **10×**, esperar o VLT-19 parar antes de
L2-S11, reconhecer o alarme crítico e liberar a TSR-08fe2b com `OP-4471`.

## Identidade: bandeira de Santos

Vermelho do escudo, dourado da coroa mural e verde do louro aparecem só como
**marca**: a faixa tricolor no topo, o brasão estilizado (também favicon), o
"SENTINEL" do logotipo e o filete dourado de cada painel. Eles nunca
substituem cores de status. O vermelho crítico dos alarmes é outro token
(`--s-crit`), e os botões de confirmar usam o verde de status "good", para
que nada do brasão seja lido como alarme.

## Arquitetura

```
src/
  data/mock.ts        sementes: mesmos IDs e cenários dos testes e bancos do projeto
  domain/line.ts      geometria do loop (seção, próxima parada, distância à frente)
  state/
    reducer.ts        reducer puro: toda regra do painel (sessão, alarme, liberação, simulação)
    selectors.ts      valores derivados — KPIs nunca são digitados à mão
    CcoProvider.tsx   useReducer + contexto + relógio da simulação
  components/         um componente por painel
  theme.css           tokens claro/escuro + componentes
```

O reducer não lê o relógio: o horário chega na ação (`at`), então ele é
determinístico e testável sem DOM. As regras com semântica de segurança estão
cobertas em [`tests/cco-dashboard.test.ts`](../../tests/cco-dashboard.test.ts),
que roda com o resto da suíte (`npm test`). Os testes:

- liberação recusada com matrícula errada, vazia ou sem operador no posto;
- nenhuma composição entra em seção restrita ativa (3.000 passos a 10×);
- distância mínima entre composições sempre mantida;
- reducer nunca muta o estado anterior.

As fontes (IBM Plex) são empacotadas no build via `@fontsource`, só o subconjunto
latino: a rede de um CCO é isolada da internet, então o painel não depende de
Google Fonts.

## O que isto não é

Os dados são mockados e a simulação roda só no navegador. Nada é enviado a
nenhum serviço. A IHM ligada ao barramento real é o `services/operator-api`
(SSE). Este painel é a referência de interface para quando ela for migrada
para React.
