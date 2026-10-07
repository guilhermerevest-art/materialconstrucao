import { describe, expect, it } from 'vitest';
import { formatWhatsapp, normalizeWhatsapp } from '../src/lib/phone.js';

describe('normalizeWhatsapp', () => {
  it.each([
    ['(11) 98765-4321', '5511987654321'],
    ['11987654321', '5511987654321'],
    ['011 98765-4321', '5511987654321'],
    ['+55 (11) 98765-4321', '5511987654321'],
    ['55 11 98765 4321', '5511987654321'],
    ['0055 11 98765-4321', '5511987654321'],
    ['(11) 3333-1000', '551133331000'],
    // DDD 55 (Santa Maria/RS) não pode ser confundido com o DDI.
    ['(55) 99999-8888', '5555999998888'],
    ['+1 (415) 555-2671', '14155552671'],
    ['+351 912 345 678', '351912345678'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeWhatsapp(input)).toBe(expected);
  });

  it.each(['', '98765-4321', '(11) 1234-567', '(11) 8765-43210', 'abc', '+55 11 1234'])('rejeita %j', (input) => {
    expect(normalizeWhatsapp(input)).toBeNull();
  });
});

describe('formatWhatsapp', () => {
  it('formata celular e fixo brasileiros', () => {
    expect(formatWhatsapp('5511987654321')).toBe('+55 (11) 98765-4321');
    expect(formatWhatsapp('551133331000')).toBe('+55 (11) 3333-1000');
  });

  it('mostra números estrangeiros com +', () => {
    expect(formatWhatsapp('14155552671')).toBe('+14155552671');
  });
});
