// Money is integer minor units (bigint) everywhere inside the system.
// It crosses JSON boundaries as a decimal-integer *string* ("1999"), never a JS number,
// so values above 2^53 and float artifacts (0.1 + 0.2) can't creep in.

export const CURRENCY_EXPONENT = {
  USD: 2,
  EUR: 2,
  GBP: 2,
  SGD: 2,
  JPY: 0,
  VND: 0,
  KWD: 3,
} as const;

export type Currency = keyof typeof CURRENCY_EXPONENT;
export const CURRENCIES = Object.keys(CURRENCY_EXPONENT) as [Currency, ...Currency[]];

export function isCurrency(value: string): value is Currency {
  return Object.hasOwn(CURRENCY_EXPONENT, value);
}

/**
 * "12.34" USD -> 1234n. Rejects rather than rounds: more fractional digits than the
 * currency allows is an input error, not something to fix silently.
 * Accepts a number only so provider payloads (Whop sends `total: 6.9`) can be converted
 * at the edge; String(6.9) is "6.9", and exponent forms like 1e21 are rejected.
 */
export function majorToMinor(input: string | number, currency: Currency): bigint {
  const text = typeof input === 'number' ? String(input) : input.trim();
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) throw new RangeError(`Invalid amount: ${text}`);
  const [, whole, frac = ''] = match;
  const exponent = CURRENCY_EXPONENT[currency];
  if (frac.length > exponent) {
    throw new RangeError(`${currency} allows at most ${exponent} decimal places: ${text}`);
  }
  return BigInt(whole! + frac.padEnd(exponent, '0'));
}

/** 1234n USD -> "$12.34". Formats from a decimal string, so no float conversion happens. */
export function formatMinor(minor: bigint, currency: Currency, locale = 'en-US'): string {
  const exponent = CURRENCY_EXPONENT[currency];
  const digits = minor.toString().padStart(exponent + 1, '0');
  const major = exponent === 0 ? digits : `${digits.slice(0, -exponent)}.${digits.slice(-exponent)}`;
  const formatter = new Intl.NumberFormat(locale, { style: 'currency', currency });
  // Intl.NumberFormat formats decimal strings exactly (ES2023 / Node >= 19).
  return formatter.format(major as unknown as number);
}
