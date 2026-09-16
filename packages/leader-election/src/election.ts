import type { Pool } from 'pg';

/**
 * Eleicao de lider com fencing sobre PostgreSQL.
 *
 * Resolve o ponto de ARQUITETURA.md 1.3: "rodar tres replicas do ats-core nao
 * e alta disponibilidade - e falha de seguranca". Um servico de escritor
 * unico (regulacao de headway, TSP) nao pode ter duas instancias publicando
 * comando ao mesmo tempo - o modo de falha nao e indisponibilidade, e comando
 * incoerente para a mesma composicao, que e pior.
 *
 * O mecanismo e o classico "fencing token": cada aquisicao NOVA da lideranca
 * recebe um EPOCH estritamente maior que o anterior. Um lider deposto por
 * pausa de GC ou particao de rede pode continuar achando que e lider - mas o
 * epoch que ele carrega fica velho no instante em que outro processo assume,
 * e 'renew()' com epoch desatualizado falha de forma atomica no proprio banco.
 * Sem fencing, dois processos convencidos de serem lider ao mesmo tempo e
 * exatamente o cenario que a eleicao deveria impedir.
 *
 * Toda a logica de decisao (quem ganha, quando expira) vive numa unica
 * instrucao SQL por operacao - a atomicidade e garantida pelo proprio
 * PostgreSQL (MVCC + constraint UNIQUE em 'role'), nao por um mutex em
 * processo que so protegeria contra concorrencia dentro do mesmo servico.
 */

export interface Lease {
  role: string;
  holder: string;
  epoch: number;
  acquiredAt: Date;
  expiresAt: Date;
}

function rowToLease(row: { role?: string; holder: string; epoch: string | number; acquired_at?: Date; expires_at: Date }, role: string): Lease {
  return {
    role, holder: row.holder, epoch: Number(row.epoch),
    acquiredAt: row.acquired_at ?? new Date(), expiresAt: row.expires_at,
  };
}

export class LeaderElection {
  constructor(private readonly pool: Pool, private readonly role: string, private readonly holderId: string) {}

  /**
   * Adquire a lideranca do zero - so sucede se o lease atual JA EXPIROU.
   * Sempre incrementa o epoch, mesmo que o novo holder seja o mesmo processo:
   * nao ha como distinguir "sou o mesmo lider ininterrupto" de "expirei e
   * reconquistei" sem essa aquisicao contar como nova epoca. Continuidade sem
   * bump de epoch e o que 'renew()' resolve.
   *
   * A clausula WHERE do ON CONFLICT e o ponto de atomicidade: se outro
   * processo detem um lease ainda valido, o UPDATE simplesmente nao ocorre e
   * RETURNING nao devolve linha - sem essa garantia do proprio Postgres, dois
   * processos poderiam ler "expirado" ao mesmo tempo e ambos escreverem.
   */
  async tryAcquire(leaseDurationMs: number): Promise<Lease | null> {
    const r = await this.pool.query(
      `INSERT INTO leader_lease (role, holder, epoch, acquired_at, expires_at)
       VALUES ($1, $2, 1, now(), now() + ($3 || ' milliseconds')::interval)
       ON CONFLICT (role) DO UPDATE
         SET holder = EXCLUDED.holder,
             epoch = leader_lease.epoch + 1,
             acquired_at = now(),
             expires_at = now() + ($3 || ' milliseconds')::interval
         WHERE leader_lease.expires_at < now()
       RETURNING holder, epoch, acquired_at, expires_at`,
      [this.role, this.holderId, leaseDurationMs],
    );
    return r.rows[0] ? rowToLease(r.rows[0], this.role) : null;
  }

  /**
   * Estende um lease que ja possuo, SEM trocar epoch - e o que prova posse
   * continua. So sucede se eu ainda sou o holder registrado E o epoch bate
   * exatamente: se outro processo ja assumiu (porque meu lease expirou antes
   * de eu renovar - GC pause, particao de rede), o epoch no banco ja avancou
   * e esta renovacao falha, mesmo que eu ainda me ache lider.
   */
  async renew(epoch: number, leaseDurationMs: number): Promise<Lease | null> {
    const r = await this.pool.query(
      `UPDATE leader_lease
       SET expires_at = now() + ($4 || ' milliseconds')::interval
       WHERE role = $1 AND holder = $2 AND epoch = $3
       RETURNING holder, epoch, acquired_at, expires_at`,
      [this.role, this.holderId, epoch, leaseDurationMs],
    );
    return r.rows[0] ? rowToLease(r.rows[0], this.role) : null;
  }

  /**
   * Abdicacao voluntaria (desligamento controlado). Expira o lease
   * imediatamente em vez de apagar a linha - apagar reiniciaria o contador de
   * epoch na proxima aquisicao, quebrando a garantia de que epoch so cresce
   * ao longo de toda a vida do 'role', nao so dentro de um processo.
   */
  async release(epoch: number): Promise<void> {
    await this.pool.query(
      `UPDATE leader_lease SET expires_at = now() WHERE role = $1 AND holder = $2 AND epoch = $3`,
      [this.role, this.holderId, epoch],
    );
  }

  async current(): Promise<Lease | null> {
    const r = await this.pool.query(
      `SELECT holder, epoch, acquired_at, expires_at FROM leader_lease WHERE role = $1`,
      [this.role],
    );
    return r.rows[0] ? rowToLease(r.rows[0], this.role) : null;
  }
}
