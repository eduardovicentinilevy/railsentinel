/**
 * Serializacao canonica (RFC 8785 / JCS simplificado).
 *
 * Por que isto importa: a assinatura e destacada e calculada sobre {env,data}.
 * Se dois processos serializarem o mesmo objeto com ordens de chave diferentes,
 * a verificacao falha por um motivo que nao tem nada a ver com seguranca.
 * Canonicalizar antes de assinar/verificar remove essa classe inteira de bug.
 */

export function canonicalize(value: unknown): string {
  if (value === null) return 'null';

  const t = typeof value;
  if (t === 'number') {
    if (!Number.isFinite(value as number)) {
      throw new TypeError('JSON canonico nao admite NaN/Infinity');
    }
    return JSON.stringify(value);
  }
  if (t === 'boolean' || t === 'string') return JSON.stringify(value);

  if (Array.isArray(value)) {
    return '[' + value.map(canonicalize).join(',') + ']';
  }

  if (t === 'object') {
    const obj = value as Record<string, unknown>;
    // Ordenacao por code unit UTF-16, como manda a JCS.
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(obj[k])).join(',') + '}';
  }

  throw new TypeError(`Tipo nao serializavel em JSON canonico: ${t}`);
}
