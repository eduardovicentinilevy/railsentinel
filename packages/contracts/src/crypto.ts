import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { canonicalize } from './canonical.js';
import type { Message, Signature } from './types.js';

/**
 * Assinatura Ed25519 destacada sobre a forma canonica de {env,data}.
 *
 * mTLS ja autentica o salto ate o broker. Isto cobre o que o mTLS nao cobre:
 * a mensagem atravessa broker de campo -> conduite -> broker do nucleo, e um
 * comprometimento em qualquer desses pontos intermediarios poderia injetar ou
 * alterar um alerta. A assinatura viaja com a mensagem e e verificada no
 * destino, entao a confianca nao depende da integridade dos intermediarios.
 *
 * Ed25519 e a escolha aqui por ser deterministico (sem dependencia de RNG no
 * momento da assinatura - relevante em dispositivo embarcado) e por assinar em
 * dezenas de microssegundos no Orin, o que nao pesa no orcamento de latencia.
 */

export interface KeyPair {
  publicKeyPem: string;
  privateKeyPem: string;
}

export function generateEd25519(): KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

/** Bytes efetivamente assinados. Exportado para que testes provem o acoplamento. */
export function signingInput(msg: Pick<Message, 'env' | 'data'>): Buffer {
  return Buffer.from(canonicalize({ env: msg.env, data: msg.data }), 'utf8');
}

export function signMessage(msg: Pick<Message, 'env' | 'data'>, privateKeyPem: string, kid: string): Signature {
  const key = createPrivateKey(privateKeyPem);
  const val = sign(null, signingInput(msg), key).toString('base64url');
  return { alg: 'Ed25519', kid, val };
}

export function verifyMessage(msg: Message, publicKeyPem: string): boolean {
  if (!msg.sig || msg.sig.alg !== 'Ed25519') return false;
  try {
    const key = createPublicKey(publicKeyPem);
    return verify(null, signingInput(msg), key, Buffer.from(msg.sig.val, 'base64url'));
  } catch {
    return false;
  }
}
