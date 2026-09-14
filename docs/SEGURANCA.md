# Segurança — IEC 62443 e EN 50716

## Zonas e conduítes

```
┌─ ZONA PERIFÉRICA ─────────────────────────────┐
│  Jetson Orin em totens · gateways de bordo    │
│  broker de campo (EMQX)          SL-T 2       │
└───────────────────┬───────────────────────────┘
                    │  CONDUÍTE ÚNICO
                    │  ingest-gateway
                    │  mTLS · Ed25519 · schema
                    │  teto de integridade · anti-replay
┌───────────────────┴───────────────────────────┐
│  ZONA DE INTEGRAÇÃO OPERACIONAL      SL-T 3   │
│  broker do núcleo · ats-core · operator-api   │
└───────────────────┬───────────────────────────┘
                    │  unidirecional (data diode lógico)
┌───────────────────┴───────────────────────────┐
│  DMZ — publicação GTFS-RT            SL-T 2   │
└───────────────────────────────────────────────┘

┌─ ZONA INTERNA VITAL ──────────────── SL-T 4 ──┐
│  Intertravamento · ATP · rotas                │
│  Hardware e software certificados separados.  │
│  NÃO faz parte deste repositório.             │
│  Recebe deste stack: nada com autoridade.     │
└───────────────────────────────────────────────┘
```

O `ingest-gateway` é o único processo com conexão às zonas de campo e de núcleo.
Se ele cair, o campo fica isolado do CCO **por construção** — não por regra de
firewall que alguém possa desativar. No `docker-compose.yml` isso é imposto por
redes Docker separadas: `ats-core` e `operator-api` não têm rota para a rede de
campo.

## Superfície de ataque e mitigação

| Vetor | Mitigação | Verificação |
|---|---|---|
| Evento de invasão forjado | Ed25519 + trust store | `tests/admission.test.ts` |
| Nó falsificando outro cruzamento | ACL de tópico + `src_topic_mismatch` | idem |
| Replay de `cleared` para reabrir via | Sessão de boot + seq + cache de ids + `cleared` nunca automático | `tests/contracts.test.ts` |
| Escalada de classe de integridade | Teto por dispositivo + assinatura cobre `env` | `tests/admission.test.ts` |
| Inundação da fronteira | Limite de vazão + ordem do pipeline | idem |
| Chave extraída do dispositivo | Secure Element/TPM; chave não sai do hardware | Fase 2 |
| Comprometimento do broker de campo | Assinatura fim-a-fim; broker não é confiável | por projeto |
| IA induzida a erro (adversarial) | Partição EN 50716: sem autoridade vital | `tests/safety-partition.test.ts` |

O último é o mais importante e o menos óbvio. Um modelo de visão computacional
**pode** ser enganado — por adesivo adversarial, condição de luz, oclusão. A
arquitetura não tenta impedir isso; assume que vai acontecer e garante que a
consequência seja limitada. Um modelo enganado gera alarme falso ou perde uma
detecção. Nunca aciona freio, nunca libera rota, nunca concede prioridade.

## Partição EN 50716

| Efeito | Autoridade mínima |
|---|---|
| Alarme ao operador | `basic` |
| Restrição *advisory* de velocidade | `basic` |
| **Retirar** prioridade semafórica | `basic` |
| Ajustar dwell | `basic` |
| Alerta de serviço GTFS-RT | `basic` |
| **Conceder** prioridade semafórica | `sil2` |
| Estabelecer rota de intertravamento | `sil4` |
| Liberar travamento de rota | `sil4` |
| Comandar freio de emergência | `sil4` |
| Sobrepor o ATP | `sil4` |

A assimetria retirar/conceder é o ponto central: remover uma ação permissiva é
inerentemente fail-safe, porque o pior caso é perda de desempenho. Criar
permissão não é.

Toda tentativa barrada gera registro com efeito, classe da evidência, classe
exigida, id do evento de origem e justificativa — publicado em
`core/audit/safety_violation` e exibido na IHM.

## LGPD

Câmeras em via pública capturam pedestres. Consequências práticas:

- Nenhum quadro trafega ao CCO. Só metadados (`evidence.ref` é ponteiro).
- Clipes ficam na borda com TTL curto (900 s por padrão).
- Faces e placas borradas **na borda**, antes de qualquer retenção
  (`evidence.redacted`).
- Recuperação é *pull*, sob ação identificada do operador, e fica registrada.

Isto é minimização de dados por arquitetura, não por política — a alternativa
(streaming contínuo ao CCO) seria simultaneamente pior em banda, em privacidade
e em disponibilidade.

## Pendências para a Fase 2

1. mTLS ativo com PKI interna e matrícula EST (RFC 7030)
2. Chaves em Secure Element/TPM do Orin
3. Trilha de auditoria WORM
4. IDS industrial passivo nos conduítes
5. Agilidade criptográfica: caminho para ML-DSA (FIPS 204)
6. Segregação da DMZ de publicação GTFS-RT — hoje o feed é servido pelo
   `operator-api`, que também fala com o barramento de controle. Dado que vai
   para Google Maps e Moovit não deve sair de um processo com essa conexão.
