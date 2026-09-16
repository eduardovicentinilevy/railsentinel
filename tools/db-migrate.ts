/** Aplica o schema do historiador. Idempotente: seguro rodar a cada deploy. */
import pg from 'pg';
import { migrate } from '@railsentinel/historian';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://railsentinel:railsentinel_dev@127.0.0.1:5432/railsentinel' });

await migrate(pool);
console.log('schema aplicado (db/schema.sql)');
await pool.end();
