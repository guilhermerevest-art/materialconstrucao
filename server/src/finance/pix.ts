import QRCode from 'qrcode';

/** Campo EMV: id, tamanho com dois dígitos e valor. */
const field = (id: string, value: string) => `${id}${String(value.length).padStart(2, '0')}${value}`;

/** CRC16-CCITT (polinômio 0x1021, início 0xFFFF), como o manual do BR Code pede. */
function crc16(payload: string) {
  let crc = 0xffff;
  for (const byte of Buffer.from(payload, 'utf8')) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

/** Nome e cidade do recebedor: sem acento e no tamanho do padrão. */
const plain = (value: string, max: number) =>
  value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9 .,-]/g, '')
    .trim()
    .slice(0, max);

/**
 * Chave PIX como o banco espera: CPF/CNPJ só com dígitos, telefone com +55, e-mail em
 * minúsculas, chave aleatória como veio. Devolve nulo se não parecer chave nenhuma.
 */
export function normalizePixKey(input: string): string | null {
  const value = input.trim();
  if (!value) return null;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return value.toLowerCase();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return value.toLowerCase();
  if (value.startsWith('+')) {
    const digits = value.replace(/\D/g, '');
    return digits.length >= 12 && digits.length <= 13 ? `+${digits}` : null;
  }
  // Pontos, barra e hífen: CPF ou CNPJ formatado. Parênteses ou espaço: telefone.
  const digits = value.replace(/\D/g, '');
  if (/[()\s]/.test(value)) return digits.length === 10 || digits.length === 11 ? `+55${digits}` : null;
  if (digits.length === 11 || digits.length === 14) return digits;
  return null;
}

export type PixCharge = {
  key: string;
  merchantName: string;
  merchantCity: string;
  amount: number | null;
  /** Identificador que volta no extrato do banco (até 25 letras e números). */
  txid?: string | null;
};

/** Código "copia e cola" do PIX estático (BR Code), com valor. */
export function pixPayload(charge: PixCharge) {
  const account = field('00', 'br.gov.bcb.pix') + field('01', charge.key);
  const txid = (charge.txid ?? '').replace(/[^A-Za-z0-9]/g, '').slice(0, 25) || '***';
  const payload =
    field('00', '01') +
    field('26', account) +
    field('52', '0000') +
    field('53', '986') +
    (charge.amount ? field('54', charge.amount.toFixed(2)) : '') +
    field('58', 'BR') +
    field('59', plain(charge.merchantName, 25) || 'RECEBEDOR') +
    field('60', plain(charge.merchantCity, 15) || 'BRASIL') +
    field('62', field('05', txid)) +
    '6304';
  return payload + crc16(payload);
}

/** QR Code do PIX como imagem PNG (data URL), para a tela. */
export function pixQrDataUrl(payload: string) {
  return QRCode.toDataURL(payload, { errorCorrectionLevel: 'M', margin: 1, width: 320 });
}

/** QR Code do PIX como PNG, para o PDF. */
export function pixQrPng(payload: string) {
  return QRCode.toBuffer(payload, { errorCorrectionLevel: 'M', margin: 1, width: 320 });
}
