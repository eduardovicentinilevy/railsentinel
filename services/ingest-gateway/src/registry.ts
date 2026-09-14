import { readFileSync } from 'node:fs';

/**
 * Trust store dos dispositivos de campo.
 *
 * Em producao isto nao e um arquivo: e a PKI interna. O no se matricula via EST
 * (RFC 7030), recebe certificado X.509 de vida curta com o ID no CN, e o broker
 * casa CN <-> ACL de topico. O arquivo aqui cumpre o mesmo papel na bancada da
 * Fase 1 sem exigir uma CA montada, mantendo a mesma semantica: chave publica
 * conhecida por dispositivo, com validade e estado de revogacao.
 */

export interface DeviceRecord {
  src: string;
  kid: string;
  publicKeyPem: string;
  /** Zonas em que este dispositivo tem permissao de publicar. */
  allowedZones: string[];
  allowedTypes: string[];
  /**
   * Classe de integridade MAXIMA que este dispositivo pode reivindicar.
   *
   * Sem este teto, a marcacao EN 50716 no envelope seria autodeclarada - e
   * portanto falsificavel. Um Jetson comprometido poderia carimbar 'sil4' nos
   * proprios eventos e, com isso, atravessar o SafetyGuard, que confia na
   * classe para decidir autoridade. A classe so significa alguma coisa porque
   * a fronteira a confere contra o que o dispositivo foi homologado a emitir.
   *
   *   edge:jetson:*  -> 'basic' (visao computacional, sem homologacao vital)
   *   train:*        -> 'sil2'  (odometria de bordo, rateada)
   */
  maxIntegrityClass: 'basic' | 'sil2' | 'sil4';
  status: 'active' | 'revoked';
  enrolled_at: string;
}

export class DeviceRegistry {
  readonly #byKid = new Map<string, DeviceRecord>();
  readonly #bySrc = new Map<string, DeviceRecord>();

  static fromFile(path: string): DeviceRegistry {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { devices: DeviceRecord[] };
    const reg = new DeviceRegistry();
    for (const d of raw.devices) reg.add(d);
    return reg;
  }

  add(d: DeviceRecord): void {
    this.#byKid.set(d.kid, d);
    this.#bySrc.set(d.src, d);
  }

  bySrc(src: string): DeviceRecord | undefined {
    return this.#bySrc.get(src);
  }

  byKid(kid: string): DeviceRecord | undefined {
    return this.#byKid.get(kid);
  }

  get size(): number {
    return this.#bySrc.size;
  }
}
