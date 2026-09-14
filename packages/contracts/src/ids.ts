import { randomBytes } from 'node:crypto';

/**
 * UUIDv7: 48 bits de timestamp em milissegundos + aleatoriedade.
 *
 * Escolhido no lugar do v4 porque ordena por tempo. Isso paga em dois lugares:
 * o historiador (TimescaleDB) indexa sem fragmentar o B-tree, e a ordenacao
 * natural do id ja e ordem de ocorrencia numa investigacao post-incidente.
 */
export function uuidv7(now = Date.now()): string {
  const b = randomBytes(16);
  b.writeUIntBE(now, 0, 6);
  b[6] = (b[6]! & 0x0f) | 0x70; // versao 7
  b[8] = (b[8]! & 0x3f) | 0x80; // variante RFC 4122
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function shortId(prefix: string): string {
  return `${prefix}-${randomBytes(4).toString('hex')}`;
}
