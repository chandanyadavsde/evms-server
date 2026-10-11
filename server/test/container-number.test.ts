import { describe, expect, it } from 'vitest';
import { isValidContainerNumber, normalizeContainerNumber } from '../src/domain/container-number';

describe('container number (ISO 6346)', () => {
  it('accepts valid numbers, with spaces or dashes', () => {
    expect(isValidContainerNumber('CSQU3054383')).toBe(true);
    expect(isValidContainerNumber('csqu 305438-3')).toBe(true);
  });
  it('rejects a wrong check digit or format', () => {
    expect(isValidContainerNumber('CSQU3054384')).toBe(false);
    expect(isValidContainerNumber('CSQ3054383')).toBe(false);
  });
  it('normalizes to upper case without separators', () => {
    expect(normalizeContainerNumber('msku 907032-3')).toBe('MSKU9070323');
  });
});
