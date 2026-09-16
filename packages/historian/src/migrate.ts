import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
/** dist/ -> packages/historian -> packages -> raiz do repo -> db/schema.sql */
const schemaPath = join(here, '..', '..', '..', 'db', 'schema.sql');

/** Aplica o schema. Idempotente - todo DDL usa IF NOT EXISTS. */
export async function migrate(pool: Pool): Promise<void> {
  const sql = readFileSync(schemaPath, 'utf8');
  await pool.query(sql);
}
