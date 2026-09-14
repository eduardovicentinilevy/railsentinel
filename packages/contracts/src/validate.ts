import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Message } from './types.js';

const here = dirname(fileURLToPath(import.meta.url));
/** dist/ -> packages/contracts -> packages -> raiz do repo */
const schemaRoot = join(here, '..', '..', '..', 'schemas');

function load(rel: string): object {
  return JSON.parse(readFileSync(join(schemaRoot, rel), 'utf8'));
}

const ajv = new Ajv2020({ allErrors: true, strict: false });

/**
 * Formato 'date-time' proprio, deliberadamente mais estrito que o de
 * ajv-formats: exige RFC3339 com precisao de milissegundos e sufixo Z.
 *
 * Deslocamento local ('-03:00') e recusado de proposito. Todo carimbo de tempo
 * do sistema e UTC; aceitar fuso local abriria espaco para um no mal
 * configurado emitir eventos com tres horas de diferenca, e a janela de frescor
 * do ReplayGuard passaria a rejeitar - ou pior, aceitar - pelo motivo errado.
 */
ajv.addFormat('date-time', {
  type: 'string',
  validate: (s: string) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(s) && !Number.isNaN(Date.parse(s)),
});

const envelopeValidator = ajv.compile(load('envelope.schema.json'));

/** env.type -> validador do payload. Novo tipo = uma linha aqui + um schema. */
const payloadValidators = new Map<string, ValidateFunction>([
  ['vlt.edge.intrusion.v1', ajv.compile(load('events/edge.intrusion.v1.schema.json'))],
  ['vlt.edge.health.v1', ajv.compile(load('events/edge.health.v1.schema.json'))],
  ['vlt.train.position.v1', ajv.compile(load('telemetry/train.position.v1.schema.json'))],
]);

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

function fmt(v: ValidateFunction, prefix: string): string[] {
  return (v.errors ?? []).map((e) => `${prefix}${e.instancePath || '/'} ${e.message ?? 'invalido'}`);
}

/**
 * Valida envelope e payload em duas etapas.
 * A separacao e proposital: o envelope e validado primeiro e sozinho, para que
 * uma mensagem com 'data' hostil ou gigante seja descartada sem que o schema de
 * dominio chegue a toca-la.
 */
export function validateMessage(msg: unknown): ValidationResult {
  if (!envelopeValidator(msg)) {
    return { ok: false, errors: fmt(envelopeValidator, 'envelope') };
  }
  const typed = msg as Message;
  const payloadValidator = payloadValidators.get(typed.env.type);
  if (!payloadValidator) {
    return { ok: false, errors: [`env.type desconhecido: ${typed.env.type}`] };
  }
  if (!payloadValidator(typed.data)) {
    return { ok: false, errors: fmt(payloadValidator, 'data') };
  }
  return { ok: true, errors: [] };
}

export function knownTypes(): string[] {
  return [...payloadValidators.keys()];
}
