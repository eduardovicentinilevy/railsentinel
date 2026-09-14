import { createPrivateKey, sign } from 'node:crypto';
import { canonicalize, uuidv7, type Envelope } from '@railsentinel/contracts';

/**
 * Conduite descendente: nucleo -> campo.
 *
 * O sentido ascendente ja existia; este fecha o outro lado. E aqui que a
 * assimetria de confianca aparece: no sentido ascendente o CCO desconfia do
 * campo (schema, assinatura, teto de integridade, frescor). No descendente e o
 * DISPOSITIVO que precisa desconfiar do CCO - um comando de regulacao que
 * chegue de origem nao autenticada e um vetor de ataque direto sobre a
 * circulacao.
 *
 * Por isso todo comando descendente e assinado com a chave do CCO e carrega a
 * mesma estrutura de envelope: o dispositivo verifica antes de aplicar. Sem
 * isso, quem alcancasse o broker de campo poderia mandar qualquer trem parar.
 *
 * A classe de integridade do comando e a da funcao que o emitiu - regulacao de
 * headway e 'basic'. Um comando 'basic' NAO pode exigir obediencia: a
 * especificacao de bordo trata dwell e coasting como ACONSELHAMENTO, sujeito ao
 * julgamento do operador e sempre subordinado ao ATP.
 */

export interface DownlinkSigner {
  src: string;
  kid: string;
  privateKeyPem: string;
}

export class Downlink {
  readonly #signer: DownlinkSigner;
  readonly #key: ReturnType<typeof createPrivateKey>;
  #seq = 0;
  readonly #boot = Date.now();

  constructor(signer: DownlinkSigner) {
    this.#signer = signer;
    this.#key = createPrivateKey(signer.privateKeyPem);
  }

  /** Empacota e assina um comando para um dispositivo de campo. */
  build(params: {
    type: string;
    data: Record<string, unknown>;
    line: 'L1' | 'L2';
    zone: string;
    integrityClass: 'basic' | 'sil2' | 'sil4';
    corr?: string;
  }): { env: Envelope; data: Record<string, unknown>; sig: { alg: 'Ed25519'; kid: string; val: string } } {
    const env: Envelope = {
      v: 1,
      id: uuidv7(),
      seq: ++this.#seq,
      boot: this.#boot,
      ts: new Date().toISOString(),
      src: this.#signer.src,
      site: 'santos',
      line: params.line,
      zone: params.zone,
      type: params.type,
      class: params.integrityClass,
      sev: 'info',
      ...(params.corr ? { corr: params.corr } : {}),
    };
    const val = sign(null, Buffer.from(canonicalize({ env, data: params.data }), 'utf8'), this.#key).toString('base64url');
    return { env, data: params.data, sig: { alg: 'Ed25519', kid: this.#signer.kid, val } };
  }

  /** Topico de comando do dispositivo - o mesmo que sua ACL de assinatura permite. */
  static topicFor(line: string, zone: string, srcKind: string, srcId: string, name: string): string {
    return `vlt/santos/${line}/${zone}/${srcKind}/${srcId}/cmd/${name}`;
  }
}
