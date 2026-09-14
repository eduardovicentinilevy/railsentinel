import type { OperatorAlarm, TrackRestriction } from '@railsentinel/contracts';

/**
 * Exportador GTFS Realtime.
 *
 * Emitido aqui como JSON equivalente ao FeedMessage. Em producao a serializacao
 * e Protocol Buffers segundo gtfs-realtime.proto - a forma dos objetos abaixo ja
 * e a do .proto justamente para que a troca do serializador nao mexa na logica.
 *
 * O ServiceAlert derivado de um incidente de via e o ponto onde a deteccao da
 * IA vira informacao ao cidadao: o passageiro na plataforma do Valongo descobre
 * a interrupcao pelo aplicativo no mesmo minuto em que o operador a vê no CCO.
 * Tambem e o que permite a EMTU e a ARTESP auditarem o cumprimento do quadro de
 * horarios por ferramenta independente.
 */

export interface VehiclePosition {
  vehicle: { id: string; label?: string };
  trip?: { trip_id: string; route_id: string };
  position: { latitude: number; longitude: number; speed?: number };
  current_status: 'INCOMING_AT' | 'STOPPED_AT' | 'IN_TRANSIT_TO';
  stop_id?: string;
  timestamp: number;
  occupancy_status?: string;
}

export interface TripUpdate {
  trip: { trip_id: string; route_id: string; schedule_relationship: 'SCHEDULED' | 'CANCELED' };
  vehicle: { id: string };
  stop_time_update: Array<{ stop_id: string; departure?: { delay: number }; arrival?: { delay: number } }>;
  timestamp: number;
}

export interface ServiceAlert {
  active_period: Array<{ start: number; end?: number }>;
  informed_entity: Array<{ route_id?: string; stop_id?: string }>;
  cause: 'ACCIDENT' | 'CONSTRUCTION' | 'OTHER_CAUSE' | 'TECHNICAL_PROBLEM';
  effect: 'SIGNIFICANT_DELAYS' | 'REDUCED_SERVICE' | 'NO_SERVICE' | 'DETOUR';
  header_text: { translation: Array<{ text: string; language: string }> };
  description_text: { translation: Array<{ text: string; language: string }> };
  severity_level: 'INFO' | 'WARNING' | 'SEVERE';
}

export interface FeedMessage {
  header: { gtfs_realtime_version: '2.0'; incrementality: 'FULL_DATASET'; timestamp: number };
  entity: Array<{ id: string; vehicle?: VehiclePosition; trip_update?: TripUpdate; alert?: ServiceAlert }>;
}

const OCCUPANCY_MAP: Record<string, string> = {
  empty: 'EMPTY', many_seats: 'MANY_SEATS_AVAILABLE', few_seats: 'FEW_SEATS_AVAILABLE',
  standing_room: 'STANDING_ROOM_ONLY', crushed: 'CRUSHED_STANDING_ROOM_ONLY', full: 'FULL',
};

export function alertFromIncident(alarm: OperatorAlarm, restriction?: TrackRestriction): ServiceAlert {
  const severe = alarm.severity === 'critical' || restriction?.kind === 'advisory_hold';
  const start = Math.floor(Date.parse(alarm.raised_at) / 1000);
  return {
    active_period: [{ start }],
    informed_entity: [{ route_id: alarm.line ?? 'L2' }, ...(alarm.section_id ? [{ stop_id: alarm.section_id }] : [])],
    cause: 'OTHER_CAUSE',
    effect: severe ? 'NO_SERVICE' : 'SIGNIFICANT_DELAYS',
    header_text: {
      translation: [
        { text: severe ? 'Circulacao interrompida - obstrucao na via' : 'Circulacao com velocidade reduzida', language: 'pt-BR' },
        { text: severe ? 'Service suspended - obstruction on track' : 'Reduced speed in service', language: 'en' },
      ],
    },
    description_text: {
      translation: [
        { text: `${alarm.title}. Equipes acionadas. Previsao de normalizacao em avaliacao.`, language: 'pt-BR' },
      ],
    },
    severity_level: severe ? 'SEVERE' : 'WARNING',
  };
}

export function buildFeed(params: {
  trains: Array<{ train_id: string; line: string; section_id: string; speed_kmh: number; schedule_dev_s: number; occupancy?: string; lat?: number; lon?: number; next_stop_id?: string; run_id?: string }>;
  alarms: OperatorAlarm[];
  restrictions: TrackRestriction[];
}): FeedMessage {
  const now = Math.floor(Date.now() / 1000);
  const entity: FeedMessage['entity'] = [];

  for (const t of params.trains) {
    entity.push({
      id: `vp-${t.train_id}`,
      vehicle: {
        vehicle: { id: t.train_id, label: `VLT ${t.train_id}` },
        ...(t.run_id ? { trip: { trip_id: t.run_id, route_id: t.line } } : {}),
        position: { latitude: t.lat ?? -23.96, longitude: t.lon ?? -46.33, speed: t.speed_kmh / 3.6 },
        current_status: t.speed_kmh < 1 ? 'STOPPED_AT' : 'IN_TRANSIT_TO',
        ...(t.next_stop_id ? { stop_id: t.next_stop_id } : {}),
        timestamp: now,
        ...(t.occupancy ? { occupancy_status: OCCUPANCY_MAP[t.occupancy] ?? 'MANY_SEATS_AVAILABLE' } : {}),
      },
    });

    if (t.run_id && t.next_stop_id) {
      entity.push({
        id: `tu-${t.train_id}`,
        trip_update: {
          trip: { trip_id: t.run_id, route_id: t.line, schedule_relationship: 'SCHEDULED' },
          vehicle: { id: t.train_id },
          stop_time_update: [{ stop_id: t.next_stop_id, arrival: { delay: t.schedule_dev_s } }],
          timestamp: now,
        },
      });
    }
  }

  for (const alarm of params.alarms.filter((a) => a.severity === 'critical' || a.severity === 'major')) {
    const restriction = params.restrictions.find((r) => r.section_id === alarm.section_id);
    entity.push({ id: `alert-${alarm.alarm_id}`, alert: alertFromIncident(alarm, restriction) });
  }

  return { header: { gtfs_realtime_version: '2.0', incrementality: 'FULL_DATASET', timestamp: now }, entity };
}
