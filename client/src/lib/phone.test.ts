import { describe, expect, it } from 'vitest';
import { formatPhone } from './phone';

describe('formatPhone', () => {
  it('groups an E.164 US number the way a person reads one out', () => {
    expect(formatPhone('+15550100001')).toBe('+1 555 010 0001');
  });

  it('leaves a number it does not recognise exactly as it arrived', () => {
    // A dialler-safe value must never be reshaped into a guess.
    expect(formatPhone('+442071838750')).toBe('+442071838750');
    expect(formatPhone('5550100001')).toBe('5550100001');
    expect(formatPhone('+1555010000')).toBe('+1555010000');
  });

  it('passes the phone placeholder through untouched', () => {
    expect(formatPhone('DONOR_PHONE')).toBe('DONOR_PHONE');
  });
});
