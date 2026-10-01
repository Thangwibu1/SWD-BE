/**
 * Money is handled as integer cents. PostgreSQL numeric(12,2) values arrive as
 * strings (see pool.ts), so no amount ever passes through binary floating point.
 */
const MONEY = /^(\d{1,10})(?:\.(\d{1,2}))?$/;

export function toCents(value: string): number {
  const match = MONEY.exec(value);
  if (!match) throw new Error(`Invalid money value: ${value}`);
  const cents = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  if (!Number.isSafeInteger(cents)) throw new Error(`Money value out of range: ${value}`);
  return cents;
}

export function fromCents(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new Error(`Invalid cents: ${cents}`);
  return `${Math.trunc(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

/** INV-03: total_amount = sum(quantity * unit_price), computed exactly in cents. */
export function orderTotalCents(lines: ReadonlyArray<{ quantity: number; unitPrice: string }>): number {
  return lines.reduce((sum, line) => sum + line.quantity * toCents(line.unitPrice), 0);
}
