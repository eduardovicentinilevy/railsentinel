# Console do CCO (React)

Console do operador do CCO do VLT da Baixada Santista, em React + TypeScript,
com identidade visual do brasão de Santos e dados mockados.

```bash
npm install              # na raiz do repositório (workspaces)
npm run dashboard        # http://localhost:5173
npm run dashboard:build  # gera apps/cco-dashboard/dist/, abre direto do disco
```

## Estrutura do console

A organização em console (menu lateral por grupos, cabeçalho com busca
<kbd>Ctrl</kbd>+<kbd>K</kbd>, várias seções, avisos e diálogo de confirmação) se
inspira no [CCO Rail Pulse](https://github.com/eduardovicentinilevy/cco-rail-pulse),
da Linha 6-Laranja. A identidade, o domínio e as regras são deste projeto.

| # | Seção | O que o operador faz |
|---|---|---|
| 1 | **Visão geral** | Situação da linha numa frase, KPIs, lista *Requer ação* (cada pendência com o comando que a resolve), últimos eventos e a linha agora. |
| 2 | **Linha 2** | Esquema ao vivo (Pausa / 1× / 10×), frota, desvio de tabela e o **posto da composição**: chamada de rádio e aviso de regulação de headway. |
| 3 | **Alarmes e restrições** | Reconhecimento, ações previstas de cada alarme, filtro por estado, e liberação de seção. |
| 4 | **Prioridade semafórica** | Decisões NTCIP 1202 por cruzamento e a regra de autoridade: a IA pode retirar prioridade, nunca conceder. |
| 5 | **Nós de borda** | Cobertura de detecção por cruzamento; nó offline vira pendência. |
| 6 | **Registro do turno** | Todo evento e todo comando, com operador e horário; filtro e busca sem acento. |
| 7 | **Passagem de turno** | Resumo do posto, pendências para quem assume e texto pronto para o livro de ocorrências (copiar). |

Atalhos: <kbd>1</kbd>–<kbd>7</kbd> trocam de seção, <kbd>Ctrl</kbd>+<kbd>K</kbd>
abre a busca de seções, composições e comandos. No celular o menu vira uma barra
inferior, e alarmes vêm antes do esquema.

Para ver o ciclo completo em ~1 min: seção **Linha 2**, **10×**, esperar o
VLT-19 parar antes de L2-S11, reconhecer o alarme crítico e liberar a
TSR-08fe2b com `OP-4471`.

## Regras de operação

- **Sem operador no posto, nenhum comando.** Toda ação é atribuída a uma matrícula.
- **Liberar uma seção exige confirmação dupla**: CFTV verificado *e* a matrícula
  do operador do posto digitada. O reducer recusa a ação sem os dois, não só a tela.
- **O console não comanda freio nem sinal.** Diferente de um CCO com frenagem
  de emergência, este é de Integridade Básica (EN 50716): o posto da composição
  oferece rádio e aviso de regulação (advisory). Composição atrasada nunca é
  retida — o TSP é que a ajuda.
- **Avisos espelham o registro.** Cada comando aceito gera exatamente um aviso
  na tela e uma linha no registro; um comando recusado não gera nenhum dos dois.

## Identidade: bandeira de Santos

Vermelho do escudo, dourado da coroa mural e verde do louro aparecem só como
**marca**: a coluna escura com o brasão, o filete dourado da seção ativa e de
cada painel, a faixa tricolor do cabeçalho, o brasão como marca d'água na
visão geral e como favicon. Eles nunca substituem cores de status. O vermelho
crítico é outro token (`--s-crit`), e confirmar usa o verde de status "good".

## Arquitetura

```
src/
  data/mock.ts          sementes: mesmos IDs e cenários dos testes e bancos do projeto
  domain/
    line.ts             geometria do loop (seção, próxima parada, distância à frente)
    regulation.ts       aviso de regulação de headway (advisory)
  state/
    reducer.ts          reducer puro: toda regra (posto, alarme, liberação, simulação, regulação)
    selectors.ts        valores derivados — KPIs e pendências nunca são digitados à mão
    CcoProvider.tsx     useReducer + contexto + relógio da simulação
  ui/
    UiProvider.tsx      seção (via #hash), avisos, busca, diálogo de liberação, tema
    views.ts            as 7 seções: rótulo, ícone, grupo, atalho
    handover.ts         texto da passagem de turno
  components/
    shell/              menu lateral, cabeçalho, crachá do operador
    common/             diálogo, busca Ctrl+K, avisos, filtros
    line/               esquema, frota, posto da composição
  views/                uma por seção
  theme.css             tokens claro/escuro + componentes
```

O reducer não lê o relógio: o horário chega na ação (`at`), então ele é
determinístico e testável sem DOM. As regras com semântica de segurança estão
cobertas em [`tests/cco-dashboard.test.ts`](../../tests/cco-dashboard.test.ts),
que roda com o resto da suíte (`npm test`):

- liberação recusada sem CFTV verificado, com matrícula errada, vazia ou sem operador;
- nenhuma composição entra em seção restrita ativa (3.000 passos a 10×);
- distância mínima entre composições sempre mantida;
- aviso de retenção só para composição adiantada, nunca para atrasada;
- reducer nunca muta o estado anterior.

As fontes (IBM Plex) são empacotadas no build via `@fontsource`, só o subconjunto
latino: a rede de um CCO é isolada da internet, então o console não depende de
Google Fonts.

## O que isto não é

Os dados são mockados e a simulação roda só no navegador. Nada é enviado a
nenhum serviço. A IHM ligada ao barramento real é o `services/operator-api`
(SSE). Este console é a referência de interface para quando ela for migrada
para React.
