/**
 * Modelo topologico simplificado da malha do VLT da Baixada Santista.
 *
 * Fase 1 usa um grafo estatico em memoria. Na Fase 2 esta estrutura e
 * substituida pelo modelo importado do sistema de intertravamento, com a mesma
 * interface - por isso o acesso e sempre por funcao, nunca pelos objetos crus.
 *
 * Numeros de referencia do projeto: L1 Barreiros-Porto (11,5 km, headway ~6 min)
 * e L2 em loop unidirecional pelo Centro Historico (8 km, headway ~20 min).
 */

export interface TrackSection {
  id: string;
  line: 'L1' | 'L2';
  name: string;
  length_m: number;
  /** Via compartilhada com trafego rodoviario: onde a invasao de gabarito e plausivel. */
  street_running: boolean;
  line_speed_kmh: number;
  /** Secao seguinte no sentido de marcha. L2 e loop, entao fecha em si. */
  next?: string;
  /** Cruzamento semaforico na saida da secao, se houver. */
  crossing_id?: string;
  stop_id?: string;
}

export interface Crossing {
  id: string;
  name: string;
  /** Endereco do controlador de trafego (CET-Santos) para NTCIP 1202 sobre SNMP. */
  ntcip_endpoint: string;
  /** Fase semaforica que serve o movimento longitudinal do VLT. */
  vlt_phase: number;
  cross_street: string;
}

const SECTIONS: TrackSection[] = [
  // ---- Linha 1: predominantemente segregada ----
  { id: 'L1-S01', line: 'L1', name: 'Barreiros - Sao Vicente Centro', length_m: 2400, street_running: false, line_speed_kmh: 50, next: 'L1-S02', stop_id: 'BARREIROS' },
  { id: 'L1-S02', line: 'L1', name: 'Sao Vicente Centro - Portal', length_m: 2100, street_running: false, line_speed_kmh: 50, next: 'L1-S03', stop_id: 'SV-CENTRO' },
  { id: 'L1-S03', line: 'L1', name: 'Portal - Conselheiro Nebias', length_m: 3100, street_running: false, line_speed_kmh: 60, next: 'L1-S04', stop_id: 'PORTAL' },
  { id: 'L1-S04', line: 'L1', name: 'Conselheiro Nebias - Porto', length_m: 3900, street_running: false, line_speed_kmh: 50, next: 'L1-S01', stop_id: 'C-NEBIAS', crossing_id: 'XC-ANA-COSTA' },

  // ---- Linha 2: loop unidirecional no Centro Historico, via em nivel ----
  { id: 'L2-S11', line: 'L2', name: 'Conselheiro Nebias - Ana Costa', length_m: 1200, street_running: true, line_speed_kmh: 30, next: 'L2-S12', stop_id: 'C-NEBIAS', crossing_id: 'XC-ANA-COSTA' },
  { id: 'L2-S12', line: 'L2', name: 'Ana Costa - Francisco Glicerio', length_m: 1500, street_running: true, line_speed_kmh: 30, next: 'L2-S13', stop_id: 'ANA-COSTA', crossing_id: 'XC-F-GLICERIO' },
  { id: 'L2-S13', line: 'L2', name: 'Francisco Glicerio - Campos Mello', length_m: 1400, street_running: true, line_speed_kmh: 25, next: 'L2-S14', stop_id: 'F-GLICERIO', crossing_id: 'XC-CAMPOS-MELLO' },
  { id: 'L2-S14', line: 'L2', name: 'Campos Mello - Joao Pessoa', length_m: 1100, street_running: true, line_speed_kmh: 25, next: 'L2-S15', stop_id: 'CAMPOS-MELLO', crossing_id: 'XC-JOAO-PESSOA' },
  { id: 'L2-S15', line: 'L2', name: 'Joao Pessoa - Amador Bueno', length_m: 900, street_running: true, line_speed_kmh: 20, next: 'L2-S16', stop_id: 'JOAO-PESSOA' },
  { id: 'L2-S16', line: 'L2', name: 'Amador Bueno - Terminal Valongo', length_m: 1000, street_running: true, line_speed_kmh: 20, next: 'L2-S17', stop_id: 'AMADOR-BUENO' },
  { id: 'L2-S17', line: 'L2', name: 'Valongo - Constituicao', length_m: 1300, street_running: true, line_speed_kmh: 25, next: 'L2-S11', stop_id: 'VALONGO', crossing_id: 'XC-CONSTITUICAO' },
];

const CROSSINGS: Crossing[] = [
  { id: 'XC-ANA-COSTA', name: 'Av. Ana Costa x Conselheiro Nebias', ntcip_endpoint: 'udp://10.60.12.21:161', vlt_phase: 2, cross_street: 'Av. Ana Costa' },
  { id: 'XC-F-GLICERIO', name: 'Av. Francisco Glicerio', ntcip_endpoint: 'udp://10.60.12.22:161', vlt_phase: 4, cross_street: 'Av. Francisco Glicerio' },
  { id: 'XC-CAMPOS-MELLO', name: 'Rua Campos Mello', ntcip_endpoint: 'udp://10.60.12.23:161', vlt_phase: 2, cross_street: 'R. Campos Mello' },
  { id: 'XC-JOAO-PESSOA', name: 'Rua Joao Pessoa', ntcip_endpoint: 'udp://10.60.12.24:161', vlt_phase: 6, cross_street: 'R. Joao Pessoa' },
  { id: 'XC-CONSTITUICAO', name: 'Rua da Constituicao', ntcip_endpoint: 'udp://10.60.12.25:161', vlt_phase: 2, cross_street: 'R. da Constituicao' },
];

const sectionById = new Map(SECTIONS.map((s) => [s.id, s]));
const crossingById = new Map(CROSSINGS.map((c) => [c.id, c]));

export function getSection(id: string): TrackSection | undefined {
  return sectionById.get(id);
}

export function getCrossing(id: string): Crossing | undefined {
  return crossingById.get(id);
}

export function allSections(): readonly TrackSection[] {
  return SECTIONS;
}

/**
 * Secoes a montante de uma secao alvo, ate 'depth' saltos.
 *
 * Este e o conjunto de risco numa invasao: quem ainda nao chegou na obstrucao
 * mas vai chegar. O alcance de 2 saltos cobre, nas velocidades de via da L2
 * (20-30 km/h), mais de dois minutos de aproximacao - folga suficiente para o
 * operador agir antes que qualquer composicao alcance o ponto.
 */
export function upstreamOf(sectionId: string, depth = 2): TrackSection[] {
  const out: TrackSection[] = [];
  let frontier = [sectionId];
  const seen = new Set<string>([sectionId]);
  for (let d = 0; d < depth; d++) {
    const prev = SECTIONS.filter((s) => s.next && frontier.includes(s.next) && !seen.has(s.id));
    if (prev.length === 0) break;
    for (const p of prev) {
      seen.add(p.id);
      out.push(p);
    }
    frontier = prev.map((p) => p.id);
  }
  return out;
}

/** Tempo de percurso nominal da secao, em segundos, a velocidade de via. */
export function nominalRunTimeS(section: TrackSection): number {
  return (section.length_m / 1000 / section.line_speed_kmh) * 3600;
}

/** Secoes de uma linha na ordem de marcha, com o offset linear acumulado. */
export function orderedSections(line: 'L1' | 'L2'): Array<{ section: TrackSection; startM: number }> {
  const out: Array<{ section: TrackSection; startM: number }> = [];
  let acc = 0;
  for (const s of SECTIONS) {
    if (s.line !== line) continue;
    out.push({ section: s, startM: acc });
    acc += s.length_m;
  }
  return out;
}

export function lineLengthM(line: 'L1' | 'L2'): number {
  return SECTIONS.filter((s) => s.line === line).reduce((a, s) => a + s.length_m, 0);
}

/**
 * Tempo para percorrer 'gapM' metros a partir de uma posicao linear, incluindo
 * as PARADAS encontradas no caminho.
 *
 * Esta funcao existe por causa de um bug real: o headway media apenas
 * distancia/velocidade, enquanto o setpoint (ciclo/N) inclui os dwells. A
 * diferenca sistematica era o dwell total da linha - 210 s na L2 - e fazia com
 * que mesmo trens perfeitamente espacados apresentassem erro negativo
 * permanente. O controlador entao segurava as tres composicoes no dwell maximo
 * indefinidamente e o desvio de tabela divergia.
 *
 * Medicao e setpoint precisam estar na mesma base. Headway e separacao
 * TEMPORAL, e tempo entre dois trens inclui o tempo parado.
 *
 * Consequencia util: espacamento temporal uniforme NAO significa espacamento
 * em distancia uniforme, porque as secoes tem velocidades de via diferentes.
 * O controlador equaliza tempo, que e o que o passageiro na plataforma sente.
 */
export function traversalTimeS(line: 'L1' | 'L2', fromLinearM: number, gapM: number, dwellS: number): number {
  const ordered = orderedSections(line);
  if (ordered.length === 0 || gapM <= 0) return 0;
  const total = lineLengthM(line);

  let pos = ((fromLinearM % total) + total) % total;
  let idx = ordered.findIndex(({ section, startM }) => pos >= startM && pos < startM + section.length_m);
  if (idx < 0) idx = 0;
  let offset = pos - ordered[idx]!.startM;

  let remaining = Math.min(gapM, total);
  let t = 0;

  while (remaining > 0) {
    const sec = ordered[idx]!.section;
    const avail = sec.length_m - offset;
    const step = Math.min(remaining, avail);
    t += (step / 1000 / sec.line_speed_kmh) * 3600;
    remaining -= step;
    offset += step;

    if (offset >= sec.length_m - 1e-9 && remaining > 0) {
      idx = (idx + 1) % ordered.length;
      offset = 0;
      // Cruzar para uma secao com estacao implica uma parada no caminho.
      if (ordered[idx]!.section.stop_id) t += dwellS;
    }
  }
  return t;
}
