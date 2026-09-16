import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { LeaderElection, LeaseHolder } from '@railsentinel/leader-election';

/**
 * Testes de eleicao de lider contra PostgreSQL real.
 *
 * O que se prova aqui e a propriedade que justifica o mecanismo inteiro:
 * NUNCA dois processos podem se achar lider com o mesmo epoch valido ao mesmo
 * tempo. Um mock do banco poderia esconder exatamente o tipo de bug que
 * importa - uma condicao de corrida que so aparece com MVCC e constraint
 * reais decidindo quem ganha o UPDATE.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://railsentinel:railsentinel_dev@127.0.0.1:5432/railsentinel_test';

let pool: pg.Pool | null = null;
let skipReason: string | null = null;

before(async () => {
  const candidate = new pg.Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 2000 });
  try {
    await candidate.query('SELECT 1');
    pool = candidate;
  } catch (err) {
    skipReason = `Postgres indisponivel: ${(err as Error).message}`;
    await candidate.end().catch(() => {});
  }
});

after(async () => {
  await pool?.end();
});

beforeEach(async () => {
  if (pool) await pool.query('DELETE FROM leader_lease');
});

function skipIfNoDb(t: { skip: (msg?: string) => void }): boolean {
  if (skipReason) { t.skip(skipReason); return true; }
  return false;
}

describe('LeaderElection - exclusao mutua e fencing', () => {
  test('primeiro a pedir adquire com epoch 1', async (t) => {
    if (skipIfNoDb(t)) return;
    const a = new LeaderElection(pool!, 'teste-role', 'proc-A');
    const lease = await a.tryAcquire(5000);
    assert.ok(lease);
    assert.equal(lease!.epoch, 1);
    assert.equal(lease!.holder, 'proc-A');
  });

  test('segundo processo NAO adquire enquanto o lease do primeiro e valido', async (t) => {
    if (skipIfNoDb(t)) return;
    const a = new LeaderElection(pool!, 'teste-role', 'proc-A');
    const b = new LeaderElection(pool!, 'teste-role', 'proc-B');
    await a.tryAcquire(30_000); // lease longo
    const attempt = await b.tryAcquire(30_000);
    assert.equal(attempt, null, 'B nao pode adquirir enquanto o lease de A esta vivo');
  });

  test('apos o lease expirar, outro processo adquire com epoch estritamente maior', async (t) => {
    if (skipIfNoDb(t)) return;
    const a = new LeaderElection(pool!, 'teste-role', 'proc-A');
    const b = new LeaderElection(pool!, 'teste-role', 'proc-B');
    const first = await a.tryAcquire(50); // lease curtissimo
    await new Promise((r) => setTimeout(r, 120));
    const second = await b.tryAcquire(30_000);
    assert.ok(second);
    assert.ok(second!.epoch > first!.epoch, `epoch novo (${second!.epoch}) deve ser maior que o anterior (${first!.epoch})`);
  });

  test('renew falha se outro processo ja assumiu - o fencing na pratica', async (t) => {
    if (skipIfNoDb(t)) return;
    const a = new LeaderElection(pool!, 'teste-role', 'proc-A');
    const b = new LeaderElection(pool!, 'teste-role', 'proc-B');
    const leaseA = await a.tryAcquire(50);
    await new Promise((r) => setTimeout(r, 120)); // A "trava" (pausa de GC simulada)
    const leaseB = await b.tryAcquire(30_000); // B assume durante a pausa
    assert.ok(leaseB);

    // A "acorda" e tenta renovar com o epoch antigo - deve ser recusado
    // mesmo que A ainda se ache lider.
    const renewed = await a.renew(leaseA!.epoch, 30_000);
    assert.equal(renewed, null, 'renovacao com epoch velho deve falhar - este e o fencing token protegendo contra split-brain');
  });

  test('renew bem-sucedido preserva o epoch (nao e uma nova aquisicao)', async (t) => {
    if (skipIfNoDb(t)) return;
    const a = new LeaderElection(pool!, 'teste-role', 'proc-A');
    const lease = await a.tryAcquire(5000);
    const renewed = await a.renew(lease!.epoch, 5000);
    assert.ok(renewed);
    assert.equal(renewed!.epoch, lease!.epoch, 'renovacao continua a MESMA epoca de lideranca');
  });

  test('release expira o lease sem apagar a linha - epoch nao reinicia', async (t) => {
    if (skipIfNoDb(t)) return;
    const a = new LeaderElection(pool!, 'teste-role', 'proc-A');
    const b = new LeaderElection(pool!, 'teste-role', 'proc-B');
    const lease = await a.tryAcquire(30_000);
    await a.release(lease!.epoch);

    const acquiredByB = await b.tryAcquire(5000);
    assert.ok(acquiredByB, 'apos release, outro processo pode adquirir imediatamente');
    assert.ok(acquiredByB!.epoch > lease!.epoch, 'o epoch continua a sequencia - nao reinicia em 1');
  });

  test('holder original NAO pode reconquistar durante o lease de outro', async (t) => {
    if (skipIfNoDb(t)) return;
    const a = new LeaderElection(pool!, 'teste-role', 'proc-A');
    const b = new LeaderElection(pool!, 'teste-role', 'proc-B');
    await a.tryAcquire(50);
    await new Promise((r) => setTimeout(r, 120));
    await b.tryAcquire(30_000);
    const attempt = await a.tryAcquire(30_000); // A tenta retomar
    assert.equal(attempt, null, 'A nao pode simplesmente pedir de novo enquanto B detem lease valido');
  });

  test('current() reflete o estado sem alterar nada', async (t) => {
    if (skipIfNoDb(t)) return;
    const a = new LeaderElection(pool!, 'teste-role', 'proc-A');
    assert.equal(await a.current(), null, 'nenhum lider antes de qualquer aquisicao');
    await a.tryAcquire(5000);
    const c = await a.current();
    assert.equal(c!.holder, 'proc-A');
  });
});

describe('LeaseHolder - orquestracao de ciclo de vida', () => {
  test('adquire automaticamente ao iniciar e notifica onChange', async (t) => {
    if (skipIfNoDb(t)) return;
    const holder = new LeaseHolder(pool!, 'teste-orquestrado', 'svc-A', { leaseDurationMs: 500, renewIntervalMs: 150, retryIntervalMs: 100 });
    const events: Array<{ isLeader: boolean; epoch: number | null }> = [];
    holder.onChange((s) => events.push(s));
    holder.start();
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(holder.isLeader(), true);
    assert.equal(events[0]!.isLeader, true);
    await holder.stop();
  });

  test('renova automaticamente e continua lider alem do lease original', async (t) => {
    if (skipIfNoDb(t)) return;
    const holder = new LeaseHolder(pool!, 'teste-orquestrado', 'svc-A', { leaseDurationMs: 300, renewIntervalMs: 80, retryIntervalMs: 100 });
    holder.start();
    await new Promise((r) => setTimeout(r, 200));
    const epoch1 = holder.epoch();
    await new Promise((r) => setTimeout(r, 500)); // alem do lease original de 300ms
    assert.equal(holder.isLeader(), true, 'renovacao automatica deve manter a lideranca');
    assert.equal(holder.epoch(), epoch1, 'renovacao nao deve trocar o epoch');
    await holder.stop();
  });

  test('segundo LeaseHolder assume automaticamente se o primeiro para de renovar', async (t) => {
    if (skipIfNoDb(t)) return;
    // O lado "A" usa LeaderElection diretamente, sem nenhum timer de fundo -
    // e assim que se simula um crash de verdade: A adquire e simplesmente
    // para de existir, sem chamar release() nem qualquer outra coisa. Uma
    // tentativa anterior usava LeaseHolder para os dois lados e sobrescrevia
    // 'stop' com um no-op para simular a falha, mas isso deixava o timer
    // INTERNO de A agendando 'tick()' para sempre - o processo de teste
    // nunca terminava. A causa raiz era dupla: o teste tentava desligar A sem
    // desligar seu timer, e o timer nao tinha unref() como rede de seguranca.
    const a = new LeaderElection(pool!, 'teste-falha', 'svc-A');
    await a.tryAcquire(150); // lease curto, nunca renovado - crash simulado

    const b = new LeaseHolder(pool!, 'teste-falha', 'svc-B', { leaseDurationMs: 150, renewIntervalMs: 50, retryIntervalMs: 60 });
    b.start();
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(b.isLeader(), true, 'B deve assumir apos o lease de A expirar sem renovacao');
    await b.stop();
  });

  test('notifica onChange na primeira avaliacao mesmo permanecendo em standby', async (t) => {
    if (skipIfNoDb(t)) return;
    // Bug real: uma instancia que NASCE em standby e permanece (null -> null,
    // "sem mudanca") nunca disparava onChange. Um operador olhando o log
    // dessa instancia veria silencio total, sem como distinguir "viva e
    // corretamente em standby" de "travou antes de tentar".
    const a = new LeaderElection(pool!, 'teste-notif', 'proc-A');
    await a.tryAcquire(30_000); // A detem o lease

    const b = new LeaseHolder(pool!, 'teste-notif', 'proc-B', { leaseDurationMs: 500, renewIntervalMs: 150, retryIntervalMs: 100 });
    const events: Array<{ isLeader: boolean; epoch: number | null }> = [];
    b.onChange((s) => events.push(s));
    b.start();
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(b.isLeader(), false, 'B nao deve adquirir enquanto A detem o lease');
    assert.equal(events.length, 1, 'a primeira avaliacao deve notificar mesmo permanecendo em standby');
    assert.equal(events[0]!.isLeader, false);
    await b.stop();
  });

  test('release() ao parar libera a lideranca para outro imediatamente', async (t) => {
    if (skipIfNoDb(t)) return;
    const a = new LeaseHolder(pool!, 'teste-release', 'svc-A', { leaseDurationMs: 10_000, renewIntervalMs: 3000, retryIntervalMs: 100 });
    const b = new LeaseHolder(pool!, 'teste-release', 'svc-B', { leaseDurationMs: 10_000, renewIntervalMs: 3000, retryIntervalMs: 100 });
    a.start();
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(a.isLeader(), true);
    await a.stop(); // desligamento gracioso - deve chamar release()

    b.start();
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(b.isLeader(), true, 'B assume de imediato - nao precisa esperar o lease de 10s expirar');
    await b.stop();
  });
});
