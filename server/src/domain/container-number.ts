/**
 * ISO 6346 container number check, e.g. "MSKU1234565":
 * 4 letters (owner + category), 6 digits (serial), 1 check digit.
 * Catches most typing mistakes before they reach an LR.
 */

const LETTER_VALUES: Record<string, number> = (() => {
  const values: Record<string, number> = {};
  let v = 10;
  for (const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
    if (v % 11 === 0) v++; // 11, 22, 33 are skipped
    values[ch] = v++;
  }
  return values;
})();

export function normalizeContainerNumber(input: string): string {
  return input.replace(/[\s-]/g, '').toUpperCase();
}

export function containerCheckDigit(first10: string): number {
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    const ch = first10.charAt(i);
    const value = i < 4 ? LETTER_VALUES[ch] : Number(ch);
    sum += (value ?? 0) * 2 ** i;
  }
  return (sum % 11) % 10;
}

export function isValidContainerNumber(input: string): boolean {
  const n = normalizeContainerNumber(input);
  if (!/^[A-Z]{3}[UJZR]\d{7}$/.test(n)) return false;
  return containerCheckDigit(n.slice(0, 10)) === Number(n.charAt(10));
}
