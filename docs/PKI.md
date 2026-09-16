# PKI Interna — mTLS (Fase 2)

Reproduzir: `npm run setup-pki` · testes: `tests/pki.test.ts`, `tests/mtls.test.ts`

---

## Por que isto muda em relação à Fase 1

A Fase 1 autenticava dispositivos por **convenção de chave**: um par Ed25519
gerado uma vez e distribuído fora de banda (`.secrets/devices.json`). Isso
provou o contrato de mensageria, mas não sustenta duas propriedades que a
IEC 62443 exige em campo:

- **Revogação.** Uma chave comprometida na Fase 1 só parava de ser confiável
  se alguém editasse o arquivo e reiniciasse o gateway.
- **Validade limitada.** A chave não expirava — um dispositivo desativado
  continuava tecnicamente capaz de assinar mensagens para sempre.

A PKI resolve as duas sem descartar a Fase 1: **as duas camadas continuam
coexistindo**, porque autenticam coisas diferentes.

| camada | autentica | escopo | revogável | expira |
|---|---|---|---|---|
| mTLS (X.509, esta PKI) | o **salto** até o broker | por conexão TCP | sim, imediato | 30 dias |
| Ed25519 (`packages/contracts`) | a **mensagem** | fim a fim, através do broker | não sem reemitir | não |

Um comprometimento do broker de campo não basta para forjar uma mensagem — a
assinatura Ed25519 percorre o payload independente do transporte. Um
certificado vazado não compra acesso permanente — expira em 30 dias e pode ser
revogado a qualquer momento. As duas garantias são independentes de propósito.

## Hierarquia

```
Root CA (10 anos, autoassinada)
  │  fica OFFLINE após assinar a Issuing CA - nunca mais toca disco
  │  de um processo conectado a rede
  ▼
Issuing CA (2 anos, online)
  │  assina matrículas sob demanda
  ▼
Certificados de dispositivo (30 dias, um por nó de borda + frota + gateway)
```

A separação em duas camadas é o que torna o pior cenário administrável em vez
de fatal: comprometer a Issuing CA permite revogar e reemitir todos os
certificados; comprometer a Root exigiria reconstruir a confiança de toda a
frota — por isso ela nunca fica acessível a um processo online.

## RSA-2048, não ECDSA P-256 — decisão registrada, não lacuna

`node-forge` (a única biblioteca JS madura para emissão completa de X.509)
codifica certificados apenas para chaves RSA — sua API de alto nível rejeita
chaves EC com `Unknown OID` ao tentar processar a SubjectPublicKeyInfo.

A alternativa seria montar a estrutura ASN.1 do certificado EC manualmente.
Isso foi descartado deliberadamente: é exatamente o tipo de código
criptográfico onde um OID trocado ou um encoding de assinatura incorreto passa
nos **próprios** testes (que usam o mesmo código para verificar) e falha
silenciosamente contra qualquer verificador X.509 real — OpenSSL, um broker
EMQX, um navegador. Inaceitável numa peça de confiança do sistema.

RSA-2048 é verificado neste projeto com `openssl verify`, não apenas com a
lógica própria — a prova de que os certificados são padrão-conformes, não só
"passam nos nossos testes". O custo é assinatura mais lenta que EC, irrelevante
na cadência de matrícula (uma vez por dispositivo, não por mensagem). Migrar
para ECDSA em produção é trabalho de ferramenta dedicada (step-ca, cfssl),
não de reimplementar ASN.1 X.509 em TypeScript.

## Matrícula EST simplificada (RFC 7030)

```
1. Instalação grava um TOKEN DE MATRÍCULA de uso único no dispositivo,
   fora de banda (nunca trafega por MQTT).
2. O dispositivo gera seu PRÓPRIO par de chaves. A privada nunca sai do
   processo que a gerou — em campo, do Secure Element do Jetson Orin.
3. O dispositivo envia CSR (id + chave pública) + token à Issuing CA.
4. A CA valida o token (existe, não expirou, não foi usado, corresponde
   ao id reivindicado) e emite um certificado de 30 dias.
5. O token é queimado — reuso é o sinal mais claro de que vazou.
```

A propriedade central: um comprometimento do **canal** de matrícula expõe um
certificado **público** — inofensivo por definição. Comprometer a matrícula
exigiria alcançar a chave privada dentro do próprio dispositivo, que é
exatamente o que o Secure Element torna caro.

## Amarração CN ↔ client id, na própria sessão TLS

O broker de campo (`tools/dev-brokers.ts`) exige que o **Common Name** do
certificado apresentado corresponda ao client id MQTT declarado na sessão:

```
CN do certificado:  edge:jetson:XC-ANA-COSTA-01
client id esperado: edge-jetson-XC-ANA-COSTA-01     (':' -> '-')
```

Isto é a mesma amarração que o `ingest-gateway` já fazia entre `env.src` e o
tópico (`src_topic_mismatch`), agora um nível abaixo — na própria conexão TCP,
antes de qualquer mensagem MQTT trafegar. Um certificado legítimo de um
dispositivo não pode ser usado para autenticar uma sessão que alega ser outro.

**Bug encontrado ao implementar:** a comparação inicial tentava reconstruir o
CN a partir do client id fazendo `split('-')` — ambíguo, porque o próprio id
de dispositivo já contém hífens (`XC-ANA-COSTA-01`). Ir na direção oposta (CN
→ client id esperado, sempre exatamente 2 `:` no CN) não tem essa ambiguidade.
Coberto por `tests/mtls.test.ts`.

## `getField('commonName')` retorna `null` — bug de API do node-forge

`cert.subject.getField(str)` resolve por **shortName** (`'CN'`), não pelo nome
longo (`'commonName'`), apesar do atributo carregar os dois. Passar
`'commonName'` sempre retornava `null` e fazia todo certificado parecer sem CN
— silenciosamente, sem lançar erro. Só foi pego ao cruzar com `openssl x509
-noout -subject`, fora do que os testes automatizados cobrem sozinhos.
Corrigido em `packages/pki/src/ca.ts`; regressão travada em `tests/pki.test.ts`.

## Papéis client/server exigem EKU distintos

Um certificado com `extKeyUsage: clientAuth` é recusado por qualquer cliente
TLS correto ao ser apresentado como certificado de **servidor** —
`"unsuitable certificate purpose"`. O broker de campo precisa de identidade
própria (`role: 'server'`, EKU `serverAuth`), distinta dos certificados de
dispositivo que ele verifica (EKU `clientAuth`), mesmo que ambos venham da
mesma Issuing CA.

## Verificação: TLS 1.3 e o momento da rejeição

Testando a rejeição de "sem certificado de cliente" com um cliente TLS puro,
o evento `secureConnect` do lado **cliente** disparava mesmo quando o servidor
recusava — sob TLS 1.3, a verificação do certificado do cliente pelo servidor
pode concluir *depois* que o cliente já vê o handshake como completo do
próprio ponto de vista, e a rejeição chega como alerta assíncrono.

Confirmado por depuração manual: o **listener de conexão do servidor nunca
dispara** para um cliente sem certificado válido — a garantia de segurança que
importa está intacta. O que precisava de correção era o método do teste para
observar isso (usar o registro do servidor como fonte da verdade, não o evento
do lado cliente). Documentado em `tests/mtls.test.ts`.

## Ressalvas

1. **A Root fica em disco nesta bancada.** Em campo, nunca — é gerada e usada
   uma única vez, num ambiente air-gapped, e depois arquivada offline (HSM ou
   cofre físico).
2. **Sem OCSP/CRL.** A revogação (`TrustStore`) é em memória, por processo.
   Produção exige uma lista de revogação distribuída e consultável pelo broker
   em tempo real — este pacote resolve o *modelo*, não a *distribuição*.
3. **RSA-2048, não ECDSA.** Ver seção acima.
4. **O broker de campo mTLS é Aedes, não EMQX.** Prova a integração da PKI com
   um broker MQTT real via TLS mútuo padrão; o cluster de produção (EMQX) usa
   a mesma cadeia de certificados sem mudança de protocolo.
