# Demo — Painel do Operador (dados mockados)

> A versão principal do painel é o app React em
> [`apps/cco-dashboard`](../apps/cco-dashboard), com as funções de CCO
> (reconhecimento de alarmes, liberação de restrição em dois passos, linha
> simulada, registro do turno). Este arquivo continua existindo para o caso
> em que não se pode instalar nada: é só um instantâneo estático.

`cco-dashboard.html` é uma página HTML autocontida, sem build nem servidor:
abra o arquivo direto no navegador.

```bash
xdg-open demo/cco-dashboard.html   # ou: open demo/cco-dashboard.html (macOS)
```

## O que é isto, e o que não é

Este arquivo **não** é o `services/operator-api`. O operator-api é a IHM real
do sistema — projeta o estado do barramento MQTT ao vivo via SSE, e exige a
bancada inteira rodando (`npm run brokers`, `gateway`, `ats`, etc; ver
[`../docs/RUNBOOK.md`](../docs/RUNBOOK.md)).

`cco-dashboard.html` existe para o caso oposto: mostrar a forma do sistema
**sem** nenhuma dependência — para uma demonstração rápida, uma reunião, um
link enviado a alguém que não vai clonar o repositório. Os dados são estáticos
e mockados, escritos no próprio arquivo (array `TRAINS`, `ALARMS`,
`RESTRICTIONS`, `TSP`, `EDGE_NODES` no `<script>` no fim do HTML) — só o
relógio no topo usa a hora real do navegador. Nada aqui lê ou grava em nenhum
serviço do repositório.

Os números mockados não são arbitrários: reaproveitam os mesmos IDs, seções,
modelos e cenários usados nos testes e nos bancos de evidência do projeto
(`VLT-07/12/19`, seções `L2-S11..S17`, o incidente de invasão do
`railguard-yolo`, os ganhos `Kp=0.51 Ki=0.017` do banco de estabilidade), para
que a demonstração seja reconhecível por quem já leu `docs/ARQUITETURA.md` ou
`docs/ESTABILIDADE.md`.

## Atualizando

É um arquivo único — edite o HTML/CSS/JS diretamente. As seções relevantes:

- `<style>` no topo — tokens de tema (claro/escuro) e componentes
- objetos `TRAINS`/`ALARMS`/`RESTRICTIONS`/`TSP`/`EDGE_NODES` no `<script>` —
  os dados mockados
- funções `render*()` — montagem do DOM a partir desses dados

O botão "Confirmar liberação" no card de restrição é funcional (o card muda
de estado ao confirmar), mas só no navegador de quem abriu a página — nada é
persistido nem compartilhado.
