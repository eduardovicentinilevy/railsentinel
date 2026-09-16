# SNMPv3/USM no HIL NTCIP (Fase 2)

Reproduzir: `tests/ntcip-snmpv3.test.ts`

---

## Por que isto muda em relação à Fase 1

O agente SNMP do HIL rodava com `disableAuthorization: true` — qualquer
cliente na rede conseguia ler o estado do sinal (fase ativa, tempo até o
verde do VLT) sem credencial nenhuma. Community string em claro (SNMPv1/v2c)
tem o mesmo problema: a "senha" trafega sem cifra e sem prova de origem.
Inaceitável para um objeto que informa o estado de um cruzamento urbano.

SNMPv3 com USM (*User-based Security Model*), nível `authPriv`: autenticação
via SHA-256 e cifra via AES. Uma tentativa sem credenciais corretas não recebe
erro informativo específico — timeout ou "Unknown User Name" — que é o
comportamento correto (RFC 3414): o nome de usuário não é segredo, a chave é.

## O bug que não parecia bug: `NoAccess` disfarçado de falha de credencial

Ao testar o GET de ponta a ponta com um cliente SNMPv3 real, credenciais
corretas retornavam `NoAccess` — indistinguível, à primeira vista, de um
problema de permissão do usuário.

A causa raiz estava em outro lugar: `net-snmp` consulta **duas** camadas de
autorização em sequência —

1. `provider.maxAccess` (RFC 1213 MAX-ACCESS) — controla se o *objeto* é
   sequer legível, independente de quem pergunta;
2. o modelo de controle de acesso por usuário (USM) — controla se *este
   usuário* pode lê-lo.

O provedor escalar do emulador nunca declarava `maxAccess`, e o valor padrão
não satisfaz "pelo menos read-only" — então **todo** GET falhava na primeira
camada, antes de a verificação de usuário sequer ser consultada. O sintoma
(`NoAccess`) é o mesmo que a segunda camada produziria para um usuário sem
permissão, o que tornou o diagnóstico enganoso até a leitura do código-fonte
de `Agent.prototype.isAllowed` em `net-snmp`.

```ts
mib.registerProvider({
  name, type: snmp.MibProviderType.Scalar, oid, scalarType: snmp.ObjectType.Integer,
  maxAccess: snmp.MaxAccess['read-only'],   // sem isto, NoAccess sempre
  handler: (req) => req.done({ ... }),
});
```

Coberto por teste de regressão explícito
(`regressao: provider sem maxAccess falhava com NoAccess mesmo com credenciais corretas`).

## Convenção OID: objetos escalares residem em `OID.0`

Um segundo obstáculo, menor mas igualmente silencioso: um objeto SNMP
**escalar** não existe no OID que você registra — existe em `OID + ".0"`, a
*instância* daquele nó. `net-snmp` só adiciona essa instância à árvore MIB na
primeira chamada de `setScalarValue()`. Consultar o OID base (sem `.0`)
sempre retorna `NoSuchInstance`, mesmo que o provedor esteja corretamente
registrado. Testado explicitamente para não ser redescoberto.

## O que ficou de fora, deliberadamente

O pedido de prioridade (`phase_call`/`green_extension`/`red_truncation`)
continua chegando por um **canal MQTT dedicado**, não por SNMP SET. Isso não
é uma simplificação de conveniência: a biblioteca de agente usada não expõe
um hook de SET com a semântica necessária para aplicar um pedido composto
(fase + classe de veículo + estratégia) como uma transação atômica sobre a
máquina de estados do controlador. A tradução para objetos MIB
(`services/ats-core/src/tsp.ts`) já usa os OIDs reais da árvore NTCIP —
trocar o canal por SNMP SET autenticado contra hardware real da CET-Santos é
trabalho de Fase 3, sem mudança na camada de decisão.

## Ressalvas

1. **Credenciais em variável de ambiente, com padrão de bancada.** Como a
   PKI e as chaves de assinatura, nunca hardcoded — mas os valores default
   servem só para não exigir configuração extra na Fase 2.
2. **authKey/privKey fixos, sem rotação.** Diferente da PKI (certificados de
   30 dias) e do `leader_lease` (epoch), o usuário SNMPv3 não expira. Rotação
   de credenciais USM é prática padrão em campo (RFC 3414 §5) e não está
   implementada aqui.
3. **Sem SET autenticado.** Ver seção acima.
