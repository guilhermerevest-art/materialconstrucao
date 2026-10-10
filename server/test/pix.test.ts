import { describe, expect, it } from 'vitest';
import { normalizePixKey, pixPayload } from '../src/finance/pix.js';

describe('PIX (BR Code)', () => {
  it('gera o mesmo código do exemplo do manual do Banco Central', () => {
    expect(
      pixPayload({
        key: '123e4567-e12b-12d1-a456-426655440000',
        merchantName: 'Fulano de Tal',
        merchantCity: 'BRASILIA',
        amount: null,
      }),
    ).toBe('00020126580014br.gov.bcb.pix0136123e4567-e12b-12d1-a456-4266554400005204000053039865802BR5913Fulano de Tal6008BRASILIA62070503***63041D3D');
  });

  it('inclui valor e identificador, sem acento no nome e na cidade', () => {
    const payload = pixPayload({
      key: '12345678000199',
      merchantName: 'Material de Construção São João Ltda',
      merchantCity: 'São José dos Campos',
      amount: 1234.5,
      txid: 'PED-000123/P1',
    });
    expect(payload).toContain('54071234.50');
    expect(payload).toContain('5925Material de Construcao Sa');
    expect(payload).toContain('6015Sao Jose dos Ca');
    expect(payload).toContain('62150511PED000123P1');
    expect(payload).toMatch(/6304[0-9A-F]{4}$/);
  });

  it('normaliza a chave', () => {
    expect(normalizePixKey('123.456.789-09')).toBe('12345678909');
    expect(normalizePixKey('12.345.678/0001-99')).toBe('12345678000199');
    expect(normalizePixKey('(11) 98765-4321')).toBe('+5511987654321');
    expect(normalizePixKey('+55 11 98765-4321')).toBe('+5511987654321');
    expect(normalizePixKey('Loja@Exemplo.com.br')).toBe('loja@exemplo.com.br');
    expect(normalizePixKey('123E4567-E12B-12D1-A456-426655440000')).toBe('123e4567-e12b-12d1-a456-426655440000');
    expect(normalizePixKey('qualquer coisa')).toBeNull();
  });
});
