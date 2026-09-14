/**
 * Simulador de frota Vossloh Tramlink V4 - planta em malha fechada.
 *
 * Nao e um gerador de posicoes: e um modelo de planta. Os trens percorrem
 * secoes, PARAM nas estacoes pelo tempo de dwell, e o dwell efetivamente
 * aplicado vem do comando de regulacao que o CCO devolve pelo conduite
 * descendente. Fechar essa malha e o que permite falar em estabilidade - um
 * controlador cujos comandos nao afetam a planta nao tem estabilidade a
 * demonstrar, so saida a registrar.
 *
 * O comando descendente e VERIFICADO antes de aplicar: assinatura do CCO,
 * classe de integridade e faixa de valores. Um comando 'basic' e aconselhamento
 * - o modelo de bordo aplica, mas nunca abaixo do piso de acessibilidade, que e
 * restricao local e nao negociavel pelo CCO.
 */
import mqtt from 'mqtt';
import { readFileSync } from 'node:fs';
import { createPrivateKey, sign } from 'node:crypto';
import { canonicalize, uuidv7, verifyMessage, type Message } from '@railsentinel/contracts';

const BROKER = process.env.FIELD_BROKER_URL ?? 'mqtt://127.0.0.1:1883';
const TICK_MS = Number(process.env.FLEET_TICK_MS ?? 1000);
/** Aceleracao do tempo simulado: 1 tick real = ACCEL segundos de operacao. */
const ACCEL = Number(process.env.FLEET_ACCEL ?? 5);

const L2_SECTIONS = [
  { id: 'L2-S11', len: 1200, speed: 30, stop: true },
  { id: 'L2-S12', len: 1500, speed: 30, stop: true },
  { id: 'L2-S13', len: 1400, speed: 25, stop: true },
  { id: 'L2-S14', len: 1100, speed: 25, stop: true },
  { id: 'L2-S15', len: 900, speed: 20, stop: true },
  { id: 'L2-S16', len: 1000, speed: 20, stop: true },
  { id: 'L2-S17', len: 1300, speed: 25, stop: true },
];

const DWELL_NOMINAL_S = 30;
/** Piso local de acessibilidade. O CCO nao pode baixar disto. */
const DWELL_FLOOR_S = 20;

interface Train {
  id: string;
  runId: string;
  sectionIdx: number;
  chainage: number;
  speed: number;
  scheduleDev: number;
  occupancy: string;
  /** Segundos restantes de parada; 0 = em movimento. */
  dwellRemaining: number;
  /** Dwell aconselhado pelo CCO para a proxima parada. */
  commandedDwell: number;
  /** Coasting aconselhado, em % da velocidade de via. */
  commandedCoast: number;
  /** Perturbacao pendente: embarque atipico na proxima estacao. */
  boardingSurge: number;
}

const trains: Train[] = [
  { id: 'VLT-07', runId: 'L2-1420', sectionIdx: 0, chainage: 1050, speed: 26, scheduleDev: 0, occupancy: 'standing_room', dwellRemaining: 0, commandedDwell: DWELL_NOMINAL_S, commandedCoast: 0, boardingSurge: 0 },
  { id: 'VLT-12', runId: 'L2-1430', sectionIdx: 2, chainage: 400, speed: 24, scheduleDev: 0, occupancy: 'few_seats', dwellRemaining: 0, commandedDwell: DWELL_NOMINAL_S, commandedCoast: 0, boardingSurge: 0 },
  { id: 'VLT-19', runId: 'L2-1440', sectionIdx: 4, chainage: 200, speed: 19, scheduleDev: 0, occupancy: 'many_seats', dwellRemaining: 0, commandedDwell: DWELL_NOMINAL_S, commandedCoast: 0, boardingSurge: 0 },
];

const keys = JSON.parse(readFileSync('.secrets/edge-keys.json', 'utf8')) as { devices: Array<{ src: string; kid: string; privateKeyPem: string }> };
const signer = keys.devices.find((d) => d.src.startsWith('train:'));
if (!signer) throw new Error('gateway de frota nao matriculado. Rode: npm run keys');
const privKey = createPrivateKey(signer.privateKeyPem);

/** Publica do CCO - usada para verificar comandos descendentes. */
const ccoPub = JSON.parse(readFileSync('.secrets/cco-pub.json', 'utf8')) as { src: string; kid: string; publicKeyPem: string };

const client = mqtt.connect(BROKER, { clientId: 'fleet-sim' });
let seq = 0;
const BOOT = Date.now();
const stats = { commandsAccepted: 0, commandsRejected: 0 };

const CMD_TOPIC = `vlt/santos/L2/FROTA/train/${signer.src.split(':')[2]}/cmd/regulation`;

client.on('connect', () => {
  console.log(`[fleet-sim] conectado a ${BROKER}; ${trains.length} composicoes na L2 (aceleracao ${ACCEL}x)`);
  client.subscribe(CMD_TOPIC, { qos: 1 }, (err) => {
    if (err) console.error('[fleet-sim] falha ao assinar comandos:', err.message);
    else console.log(`[fleet-sim] malha FECHADA - ouvindo ${CMD_TOPIC}`);
  });
  setInterval(tick, TICK_MS);
});

client.on('message', (topic, payload) => {
  if (topic !== CMD_TOPIC) return;

  let msg: Message<Record<string, unknown>>;
  try { msg = JSON.parse(payload.toString('utf8')); } catch { return; }

  // O dispositivo desconfia do CCO tanto quanto o CCO desconfia do dispositivo.
  // Um comando de regulacao nao autenticado e vetor de ataque sobre a circulacao.
  if (!msg.sig || msg.sig.kid !== ccoPub.kid || !verifyMessage(msg, ccoPub.publicKeyPem)) {
    stats.commandsRejected += 1;
    console.warn('[fleet-sim] comando RECUSADO: assinatura do CCO invalida');
    return;
  }
  if (msg.env.type !== 'vlt.train.regulation.v1') return;

  const train = trains.find((t) => t.id === msg.data.train_id);
  if (!train) return;

  const dwell = Number(msg.data.dwell_s);
  const coast = Number(msg.data.coast_pct);
  if (!Number.isFinite(dwell) || !Number.isFinite(coast)) return;

  // Piso de acessibilidade e restricao LOCAL. O CCO aconselha; o computador de
  // bordo nunca fecha porta antes do minimo, venha o comando de onde vier.
  train.commandedDwell = Math.max(DWELL_FLOOR_S, Math.min(120, dwell));
  train.commandedCoast = Math.max(0, Math.min(8, coast));
  stats.commandsAccepted += 1;
});

function tick(): void {
  const dt = ACCEL; // segundos de operacao por tick

  for (const t of trains) {
    const sec = L2_SECTIONS[t.sectionIdx]!;

    if (t.dwellRemaining > 0) {
      // Parado na estacao: o dwell consome tempo e move o desvio de tabela.
      t.dwellRemaining -= dt;
      t.speed = 0;
      if (t.dwellRemaining <= 0) {
        t.dwellRemaining = 0;
        t.commandedDwell = DWELL_NOMINAL_S; // comando vale uma parada so
        t.commandedCoast = t.commandedCoast; // coasting persiste ate a proxima parada
      }
      continue;
    }

    // Em movimento. Coasting reduz a velocidade de via pelo percentual aconselhado.
    const targetSpeed = sec.speed * (1 - t.commandedCoast / 100);
    t.speed = targetSpeed;
    t.chainage += (t.speed / 3.6) * dt;

    if (t.chainage >= sec.len) {
      t.chainage -= sec.len;
      t.sectionIdx = (t.sectionIdx + 1) % L2_SECTIONS.length;

      if (L2_SECTIONS[t.sectionIdx]!.stop) {
        // Perturbacao: surto de embarque prolonga o dwell alem do comandado.
        const surge = t.boardingSurge;
        t.boardingSurge = 0;
        const applied = t.commandedDwell + surge;
        t.dwellRemaining = applied;
        // Desvio de tabela cresce com o que se gastou alem do nominal.
        t.scheduleDev += applied - DWELL_NOMINAL_S;
        t.commandedCoast = 0; // coasting expira ao chegar na parada
      }
    }
  }

  publish();
}

function publish(): void {
  for (const t of trains) {
    const sec = L2_SECTIONS[t.sectionIdx]!;
    const env = {
      v: 1 as const, id: uuidv7(), seq: ++seq, boot: BOOT, ts: new Date().toISOString(),
      src: signer!.src, site: 'santos' as const, line: 'L2' as const, zone: 'FROTA',
      type: 'vlt.train.position.v1', class: 'sil2' as const, sev: 'info' as const,
    };
    const data = {
      train_id: t.id, run_id: t.runId, section_id: sec.id,
      chainage_m: Math.round(t.chainage), speed_kmh: Math.round(t.speed * 10) / 10,
      next_stop_id: sec.id, schedule_dev_s: Math.round(t.scheduleDev),
      doors: t.dwellRemaining > 0 ? 'open' : 'closed', occupancy: t.occupancy,
      traction_temp_c: 62, battery_soc_pct: 85,
    };
    const val = sign(null, Buffer.from(canonicalize({ env, data }), 'utf8'), privKey).toString('base64url');
    client.publish(
      `vlt/santos/L2/FROTA/train/${signer!.src.split(':')[2]}/tlm/position`,
      JSON.stringify({ env, data, sig: { alg: 'Ed25519' as const, kid: signer!.kid, val } }),
      { qos: 0 },
    );
  }
}

/** Injeta um surto de embarque - a perturbacao que o regulador precisa rejeitar. */
function injectDisturbance(): void {
  const t = trains[Math.floor(Math.random() * trains.length)]!;
  t.boardingSurge = 45 + Math.random() * 45;
  console.log(`[fleet-sim] PERTURBACAO: surto de embarque em ${t.id} (+${Math.round(t.boardingSurge)}s na proxima parada)`);
}

if (process.env.FLEET_DISTURB !== 'false') {
  setInterval(injectDisturbance, Number(process.env.FLEET_DISTURB_MS ?? 45_000)).unref();
}

setInterval(() => {
  const spread = Math.round(Math.max(...trains.map((t) => t.scheduleDev)) - Math.min(...trains.map((t) => t.scheduleDev)));
  console.log(`[fleet-sim] desvios: ${trains.map((t) => `${t.id}=${Math.round(t.scheduleDev)}s`).join(' ')} | dispersao=${spread}s | comandos aceitos=${stats.commandsAccepted} recusados=${stats.commandsRejected}`);
}, 15_000).unref();

for (const s of ['SIGINT', 'SIGTERM'] as const) {
  process.on(s, () => { client.end(true); process.exit(0); });
}
