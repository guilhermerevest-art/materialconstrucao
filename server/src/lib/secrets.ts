import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';

/**
 * Chaves e senhas de serviços de fora (ACBr API, CSC da NFC-e, EvolutionAPI) ficam
 * criptografadas no banco com AES-256-GCM: quem lê um backup ou o banco não usa
 * a conta da loja. Formato: `enc:v1:<id da chave>:<base64url(iv | texto | tag)>`.
 *
 * A chave vem de SECRETS_KEY; sem ela, é derivada do JWT_SECRET (funciona sem
 * configurar nada, mas trocar o JWT_SECRET exige informar as chaves de novo).
 * Valores antigos, em texto, continuam sendo lidos até o db:migrate cifrá-los.
 */
const PREFIX = 'enc:v1:';

type Key = { id: string; key: Buffer };

let keys: { current: Key; previous: Key[] } | null = null;

function keyFrom(material: Buffer): Key {
  return { id: createHash('sha256').update(material).digest('hex').slice(0, 8), key: material };
}

const fromSecretsKey = (value: string) => keyFrom(createHash('sha256').update(value, 'utf8').digest());
const fromJwtSecret = (value: string) =>
  keyFrom(Buffer.from(hkdfSync('sha256', value, 'materialconstrucao', 'secrets/v1', 32)));

/** Prepara as chaves. A app chama ao subir; o db:migrate, antes de cifrar o que está em texto. */
export function initSecrets(options: { jwtSecret: string; secretsKey?: string; previousKeys?: string[] }) {
  const jwtKey = fromJwtSecret(options.jwtSecret);
  const current = options.secretsKey ? fromSecretsKey(options.secretsKey) : jwtKey;
  const previous = [...(options.previousKeys ?? []).map(fromSecretsKey), ...(options.secretsKey ? [jwtKey] : [])];
  keys = { current, previous: previous.filter((k) => k.id !== current.id) };
}

function requireKeys() {
  if (!keys) throw new Error('As chaves de criptografia não foram preparadas (initSecrets).');
  return keys;
}

export const isSealed = (value: string) => value.startsWith(PREFIX);

/** Cifra para gravar no banco. Vazio continua vazio. */
export function sealSecret(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (isSealed(value)) return value;
  const { current } = requireKeys();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', current.key, iv);
  const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `${PREFIX}${current.id}:${Buffer.concat([iv, body, cipher.getAuthTag()]).toString('base64url')}`;
}

/**
 * Abre o que veio do banco. Texto puro (de antes da criptografia) volta como está.
 * Cifrado com uma chave que não existe mais vira null: a tela pede para informar de novo.
 */
export function openSecret(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (!isSealed(value)) return value;
  const { current, previous } = requireKeys();
  const [id, payload] = value.slice(PREFIX.length).split(':');
  const key = [current, ...previous].find((k) => k.id === id);
  if (!key || !payload) {
    console.warn(`[segredos] valor cifrado com uma chave desconhecida (${id}); informe a chave de novo na tela.`);
    return null;
  }
  try {
    const raw = Buffer.from(payload, 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', key.key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(raw.length - 16));
    return Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]).toString('utf8');
  } catch {
    console.warn('[segredos] não foi possível abrir um valor cifrado; informe a chave de novo na tela.');
    return null;
  }
}

/** Precisa cifrar (ou cifrar de novo com a chave atual)? */
export function needsSealing(value: string | null) {
  if (!value) return false;
  if (!isSealed(value)) return true;
  return !value.startsWith(`${PREFIX}${requireKeys().current.id}:`);
}
