/**
 * Matricula de dispositivos para a bancada da Fase 1.
 *
 * Gera um par Ed25519 por no de borda e escreve dois arquivos:
 *   .secrets/devices.json    -> trust store do gateway (SOMENTE chaves publicas)
 *   .secrets/edge-keys.json  -> chaves privadas dos simuladores
 *
 * A separacao e deliberada mesmo numa bancada: o processo que VERIFICA nunca
 * deve ter acesso ao material que ASSINA. Em campo a chave privada nao chega
 * sequer a existir em disco - e gerada dentro do Secure Element / TPM do Orin,
 * nao pode ser extraida, e o dispositivo se matricula via EST (RFC 7030)
 * enviando so a CSR.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { generateEd25519 } from '@railsentinel/contracts';

interface NodeSpec {
  id: string; line: 'L1' | 'L2'; zone: string; section_id: string; lat: number; lon: number;
  /** edge = toten de cruzamento; train = gateway de bordo da composicao. */
  kind?: 'edge' | 'train';
  platform?: string;
  types?: string[];
  /** Teto de integridade homologado para o dispositivo. */
  maxClass?: 'basic' | 'sil2' | 'sil4';
}

const NODES: NodeSpec[] = [
  { id: 'XC-ANA-COSTA-01',   line: 'L2', zone: 'XC-ANA-COSTA',   section_id: 'L2-S11', lat: -23.9618, lon: -46.3322 },
  { id: 'XC-F-GLICERIO-01',  line: 'L2', zone: 'XC-F-GLICERIO',  section_id: 'L2-S12', lat: -23.9596, lon: -46.3288 },
  { id: 'XC-CAMPOS-MELLO-01',line: 'L2', zone: 'XC-CAMPOS-MELLO',section_id: 'L2-S13', lat: -23.9351, lon: -46.3269 },
  { id: 'XC-JOAO-PESSOA-01', line: 'L2', zone: 'XC-JOAO-PESSOA', section_id: 'L2-S14', lat: -23.9327, lon: -46.3241 },
  { id: 'XC-CONSTITUICAO-01',line: 'L2', zone: 'XC-CONSTITUICAO',section_id: 'L2-S17', lat: -23.9310, lon: -46.3195 },
  // Gateway de bordo da frota: identidade e ACL distintas dos totens de rua.
  // Publica telemetria de posicao, nunca eventos de invasao - a separacao de
  // 'allowedTypes' impede que um comprometimento a bordo gere alarme de via.
  { id: 'FLEET-GW', line: 'L2', zone: 'FROTA', section_id: 'L2-S11', lat: -23.9618, lon: -46.3322,
    kind: 'train', platform: 'tramlink', types: ['vlt.train.position.v1'], maxClass: 'sil2' },
];

const epoch = new Date().toISOString().slice(0, 7); // rotacao mensal
const publicRecords: unknown[] = [];
const privateRecords: unknown[] = [];

for (const n of NODES) {
  const { publicKeyPem, privateKeyPem } = generateEd25519();
  const src = `${n.kind ?? 'edge'}:${n.platform ?? 'jetson'}:${n.id}`;
  const kid = `${n.id}:${epoch}`;

  publicRecords.push({
    src, kid, publicKeyPem,
    allowedZones: [n.zone],
    allowedTypes: n.types ?? ['vlt.edge.intrusion.v1', 'vlt.edge.health.v1'],
    // Visao computacional nunca passa de Integridade Basica. E o teto que torna
    // a marcacao do envelope confiavel a jusante.
    maxIntegrityClass: n.maxClass ?? 'basic',
    status: 'active',
    enrolled_at: new Date().toISOString(),
  });

  privateRecords.push({ src, kid, privateKeyPem, line: n.line, zone: n.zone, section_id: n.section_id, lat: n.lat, lon: n.lon });
}

// Identidade de assinatura do CCO para o conduite DESCENDENTE.
// A chave privada fica so no lado do gateway; os dispositivos recebem apenas a
// publica, para verificar comandos antes de aplicar.
const cco = generateEd25519();
const ccoKid = `CCO-SANTOS:${epoch}`;

mkdirSync('.secrets', { recursive: true });
writeFileSync('.secrets/cco-key.json', JSON.stringify({
  src: 'cco:santos:CCO-SANTOS', kid: ccoKid, privateKeyPem: cco.privateKeyPem,
}, null, 2));
writeFileSync('.secrets/cco-pub.json', JSON.stringify({
  src: 'cco:santos:CCO-SANTOS', kid: ccoKid, publicKeyPem: cco.publicKeyPem,
}, null, 2));
writeFileSync('.secrets/devices.json', JSON.stringify({ devices: publicRecords }, null, 2));
writeFileSync('.secrets/edge-keys.json', JSON.stringify({ devices: privateRecords }, null, 2));

console.log(`${NODES.length} nos matriculados (epoca de chave ${epoch})`);
console.log('  .secrets/devices.json    - trust store do gateway (publicas)');
console.log('  .secrets/edge-keys.json  - chaves dos simuladores (privadas, fora do git)');
console.log('  .secrets/cco-key.json    - chave de assinatura do CCO (descendente)');
console.log('  .secrets/cco-pub.json    - publica do CCO, distribuida aos dispositivos');
