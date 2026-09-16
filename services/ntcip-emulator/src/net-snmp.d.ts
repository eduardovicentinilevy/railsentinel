/**
 * Declaracao minima de net-snmp - a biblioteca nao publica tipos.
 * Cobre apenas a superficie que o emulador usa (agente + MIB escalar).
 */
declare module 'net-snmp' {
  export const ObjectType: { Integer: number; OctetString: number; Counter32: number; Gauge32: number };
  export const MibProviderType: { Scalar: number; Table: number };
  export const SecurityLevel: { noAuthNoPriv: number; authNoPriv: number; authPriv: number };
  export const AuthProtocols: { none: number; md5: number; sha: number; sha256: number };
  export const PrivProtocols: { none: number; des: number; aes: number };
  export const AccessControlModelType: { Simple: number };
  export const AccessLevel: { ReadOnly: number; ReadWrite: number };
  export const MaxAccess: { 'not-accessible': number; 'read-only': number; 'read-write': number; 'read-create': number };

  export interface V3User {
    name: string;
    level: number;
    authProtocol?: number;
    authKey?: string;
    privProtocol?: number;
    privKey?: string;
  }

  export interface MibRequest {
    done(result?: { type: number; value: number | string }): void;
    operation: number;
    oid: string;
  }

  export interface MibProvider {
    name: string;
    type: number;
    oid: string;
    scalarType?: number;
    maxAccess?: number;
    handler?: (req: MibRequest) => void;
  }

  export interface Mib {
    registerProvider(provider: MibProvider): void;
    setScalarValue(name: string, value: number | string): void;
    getScalarValue(name: string): number | string;
  }

  export interface Authorizer {
    addUser(user: V3User): void;
    addCommunity(community: string): void;
  }

  export interface Agent {
    getMib(): Mib;
    getAuthorizer(): Authorizer;
    close(): void;
  }

  export function createAgent(
    options: { port?: number; disableAuthorization?: boolean; accessControlModelType?: number },
    callback: (error: Error | null, data?: unknown) => void,
  ): Agent;

  export interface Session {
    get(oids: string[], cb: (error: Error | null, varbinds: Array<{ oid: string; value: number | string; type: number }>) => void): void;
    close(): void;
  }

  export function createSession(target: string, community: string, options?: { port?: number; timeout?: number; retries?: number }): Session;
  export function isVarbindError(varbind: unknown): boolean;
  export function varbindError(varbind: unknown): string;
}
