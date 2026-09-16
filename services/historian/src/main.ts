import mqtt from 'mqtt';
import pg from 'pg';
import {
  CORE, type IntrusionData, type Message,
  type OperatorAlarm, type TrackRestriction, type TrainPositionData, type TspDecision,
} from '@railsentinel/contracts';
import { Historian, migrate, type RejectStage, type SafetyViolation } from '@railsentinel/historian';

/**
 * historian - projecao duravel do barramento do nucleo (Fase 2).
 *
 * Assina os mesmos topicos que o operator-api ja consome para a IHM, mas em
 * vez de manter estado em memoria para exibicao ao vivo, grava cada evento no
 * PostgreSQL de forma idempotente. E o servico que responde "o que aconteceu
 * na secao L2-S11 entre 14h e 15h?" depois que o processo do ats-core ja
 * reiniciou tres vezes e a memoria de qualquer servico em execucao esqueceu.
 *
 * Escrita apenas - nenhum caminho deste servico decide nada sobre a
 * circulacao. Um historiador fora do ar atrasa a auditoria, nunca a operacao.
 */

const CORE_URL = process.env.CORE_BROKER_URL ?? 'mqtt://127.0.0.1:1884';
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://railsentinel:railsentinel_dev@127.0.0.1:5432/railsentinel';

const log = (lvl: string, msg: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), svc: 'historian', lvl, msg, ...extra }));

const pool = new pg.Pool({ connectionString: DATABASE_URL });
pool.on('error', (err) => log('error', 'erro na pool de conexoes', { err: err.message }));

await migrate(pool);
log('info', 'schema verificado/aplicado');

const historian = new Historian(pool);
const bus = mqtt.connect(CORE_URL, { clientId: 'historian', clean: true, reconnectPeriod: 1000 });

const stats = { written: 0, failed: 0 };

bus.on('connect', () => {
  log('info', 'conectado ao barramento do nucleo', { url: CORE_URL });
  const subs = [
    CORE.normalizedIntrusion, CORE.normalizedHealth, CORE.normalizedPosition,
    CORE.operatorAlarm, CORE.trackRestriction, CORE.tspDecision,
    CORE.safetyViolation, CORE.auditRejected, 'ntcip/+/grant', 'core/cmd/operator/#',
  ];
  for (const t of subs) bus.subscribe(t, { qos: 1 });
});

bus.on('error', (e) => log('error', 'erro no barramento', { err: e.message }));

/** Correlaciona secao -> incidente aberto, para amarrar cada deteccao ao mesmo incident_id da IHM. */
const openIncidentBySection = new Map<string, string>();

bus.on('message', async (topic, payload) => {
  let obj: unknown;
  try { obj = JSON.parse(payload.toString('utf8')); } catch { return; }

  try {
    switch (topic) {
      case CORE.normalizedIntrusion: {
        const msg = obj as Message<IntrusionData>;
        const sectionId = msg.data.track.section_id;
        let incidentId = openIncidentBySection.get(sectionId);
        if (!incidentId) {
          incidentId = `INC-${msg.env.id.slice(0, 8)}`;
          openIncidentBySection.set(sectionId, incidentId);
        }
        await historian.recordIntrusion(msg, incidentId);
        break;
      }
      case CORE.normalizedPosition:
        await historian.recordPosition(obj as Message<TrainPositionData>);
        break;
      case CORE.operatorAlarm:
        await historian.recordAlarm(obj as OperatorAlarm);
        break;
      case CORE.trackRestriction: {
        const r = obj as TrackRestriction & { cleared?: boolean; section_id: string; cleared_by?: string };
        if (r.cleared) {
          await historian.clearRestriction(r.section_id, r.cleared_by ?? 'desconhecido');
          openIncidentBySection.delete(r.section_id);
        } else {
          await historian.recordRestriction(r as TrackRestriction);
        }
        break;
      }
      case CORE.tspDecision:
        // O pedido e gravado sem desfecho; o desfecho real chega depois, num
        // topico separado ('.../grant'), porque o HIL responde de forma
        // assincrona. UPDATE por crossing_id + decided_at aproxima o par
        // pedido/resposta mais recente - suficiente na bancada, onde o
        // debounce do ats-core (services/ats-core/src/tsp.ts) ja impede mais
        // de um pedido em voo por cruzamento ao mesmo tempo.
        await historian.recordTspDecision(obj as TspDecision);
        break;
      case CORE.safetyViolation:
        await historian.recordSafetyViolation(obj as SafetyViolation);
        log('warn', 'VIOLACAO DE PARTICAO gravada na trilha de auditoria', obj as Record<string, unknown>);
        break;
      case CORE.auditRejected:
        await historian.recordRejection(obj as { at: string; stage: RejectStage; detail: string; topic: string; src?: string });
        break;
      default:
        if (topic.endsWith('/grant')) {
          const grant = obj as { crossing_id: string; granted: boolean; reason?: string };
          await historian.updateTspOutcome(grant.crossing_id, grant.granted, grant.reason);
        } else if (topic.startsWith('core/cmd/operator/clear_section')) {
          const cmd = obj as { section_id: string; operator_id: string };
          await historian.clearRestriction(cmd.section_id, cmd.operator_id);
        }
    }
    stats.written += 1;
  } catch (err) {
    stats.failed += 1;
    log('error', 'falha ao gravar evento', { topic, err: (err as Error).message });
  }
});

setInterval(() => log('info', 'metricas de gravacao', { ...stats }), 30_000).unref();

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => { log('info', 'encerrando historiador'); bus.end(true); await pool.end(); process.exit(0); });
}
