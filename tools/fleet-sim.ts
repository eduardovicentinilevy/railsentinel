/**
 * Simulador de frota Vossloh Tramlink V4.
 *
 * Publica telemetria de posicao no broker de CAMPO para alimentar o regulador
 * de headway e o gate do TSP. Os trens sao injetados com desvios de tabela
 * diferentes de proposito - um adiantado, um no horario, um bem atrasado -
 * porque e a assimetria que exercita a logica: o adiantado NAO deve receber
 * prioridade semaforica, e o atrasado deve.
 */
import mqtt from 'mqtt';
import { readFileSync } from 'node:fs';
import { createPrivateKey, sign } from 'node:crypto';
import { canonicalize, uuidv7 } from '@railsentinel/contracts';

const BROKER = process.env.FIELD_BROKER_URL ?? 'mqtt://127.0.0.1:1883';

interface Train {
  id: string; line: 'L1' | 'L2'; sectionIdx: number; chainage: number;
  speed: number; scheduleDev: number; occupancy: string; runId: string;
}

const L2_SECTIONS = [
  { id: 'L2-S11', len: 1200, speed: 30 }, { id: 'L2-S12', len: 1500, speed: 30 },
  { id: 'L2-S13', len: 1400, speed: 25 }, { id: 'L2-S14', len: 1100, speed: 25 },
  { id: 'L2-S15', len: 900, speed: 20 },  { id: 'L2-S16', len: 1000, speed: 20 },
  { id: 'L2-S17', len: 1300, speed: 25 },
];

const trains: Train[] = [
  { id: 'VLT-07', line: 'L2', sectionIdx: 0, chainage: 1050, speed: 26, scheduleDev: 95,  occupancy: 'standing_room', runId: 'L2-1420' },
  { id: 'VLT-12', line: 'L2', sectionIdx: 2, chainage: 400,  speed: 24, scheduleDev: -40, occupancy: 'few_seats',     runId: 'L2-1430' },
  { id: 'VLT-19', line: 'L2', sectionIdx: 4, chainage: 200,  speed: 19, scheduleDev: 12,  occupancy: 'many_seats',    runId: 'L2-1440' },
];

// Identidade dedicada do gateway de bordo, com ACL propria: so pode publicar
// telemetria de posicao. Em campo cada composicao tem o proprio certificado.
const keys = JSON.parse(readFileSync('.secrets/edge-keys.json', 'utf8')) as { devices: Array<{ src: string; kid: string; privateKeyPem: string }> };
const signer = keys.devices.find((d) => d.src.startsWith('train:'));
if (!signer) throw new Error('gateway de frota nao matriculado. Rode: npm run keys');
const privKey = createPrivateKey(signer.privateKeyPem);

const client = mqtt.connect(BROKER, { clientId: 'fleet-sim' });
let seq = 0;
/** Sessao de boot deste processo - zera 'seq' sem parecer replay. */
const BOOT = Date.now();

client.on('connect', () => {
  console.log(`[fleet-sim] conectado a ${BROKER}; simulando ${trains.length} composicoes na L2`);
  setInterval(tick, 2000);
});

function tick(): void {
  for (const t of trains) {
    const sec = L2_SECTIONS[t.sectionIdx]!;
    t.chainage += (t.speed / 3.6) * 2;
    if (t.chainage >= sec.len) {
      t.chainage -= sec.len;
      t.sectionIdx = (t.sectionIdx + 1) % L2_SECTIONS.length;
      // Dwell na estacao move o desvio de tabela: e assim que o atraso se
      // propaga e que o regulador ganha algo para corrigir.
      t.scheduleDev += Math.round((Math.random() - 0.45) * 25);
    }
    const nextSec = L2_SECTIONS[t.sectionIdx]!;
    t.speed = Math.max(0, nextSec.speed + (Math.random() - 0.5) * 6);

    const env = {
      v: 1 as const, id: uuidv7(), seq: ++seq, boot: BOOT, ts: new Date().toISOString(),
      src: signer.src, site: 'santos' as const, line: t.line, zone: 'FROTA',
      type: 'vlt.train.position.v1', class: 'sil2' as const, sev: 'info' as const,
    };
    const data = {
      train_id: t.id, run_id: t.runId, section_id: nextSec.id,
      chainage_m: Math.round(t.chainage), speed_kmh: Math.round(t.speed * 10) / 10,
      next_stop_id: nextSec.id, schedule_dev_s: t.scheduleDev,
      doors: t.speed < 1 ? 'open' : 'closed', occupancy: t.occupancy,
      traction_temp_c: Math.round(55 + Math.random() * 20), battery_soc_pct: Math.round(78 + Math.random() * 15),
    };
    const val = sign(null, Buffer.from(canonicalize({ env, data }), 'utf8'), privKey).toString('base64url');
    const msg = { env, data, sig: { alg: 'Ed25519' as const, kid: signer.kid, val } };

    client.publish(`vlt/santos/${t.line}/FROTA/train/${signer.src.split(':')[2]}/tlm/position`, JSON.stringify(msg), { qos: 0 });
  }
}

for (const s of ['SIGINT', 'SIGTERM'] as const) {
  process.on(s, () => { client.end(true); process.exit(0); });
}
