import { z } from 'zod';
import { CURRENCIES } from './money.js';

// The ONE definition of a valid receipt request. Imported by:
//   - web form (src/web/form.ts)       -> UX feedback, never trusted
//   - API (src/api/server.ts)          -> trust boundary, 400 on failure
//   - Kafka consumer + delivery worker -> re-validated before anything is stored/sent
// The DB CHECK constraints are the last line of defense under all of them.

// Positive integer minor units as a string; <= 18 digits always fits Postgres BIGINT.
export const AmountMinor = z
  .string()
  .regex(/^[1-9]\d{0,17}$/, 'Amount must be a positive whole number of minor units');

export const ReceiptRequest = z
  .object({
    recipientEmail: z.string().trim().toLowerCase().max(254).email('Invalid email address'),
    amountMinor: AmountMinor,
    currency: z.enum(CURRENCIES),
    paymentReference: z
      .string()
      .regex(/^[A-Za-z0-9_-]{3,64}$/, 'Reference must be 3-64 letters, digits, _ or -'),
  })
  .strict();
export type ReceiptRequest = z.infer<typeof ReceiptRequest>;

// What travels on Kafka: the request plus where it came from. Versioned so a consumer
// can reject a shape it doesn't understand instead of guessing.
export const ReceiptMessage = ReceiptRequest.extend({
  v: z.literal(1),
  provider: z.enum(['whop', 'manual']),
}).strict();
export type ReceiptMessage = z.infer<typeof ReceiptMessage>;

export type FieldErrors = Partial<Record<keyof ReceiptRequest | '_form', string[]>>;

/** Same error shape in the browser and in API 400 responses. */
export function fieldErrors(error: z.ZodError): FieldErrors {
  const flat = error.flatten();
  return { ...flat.fieldErrors, ...(flat.formErrors.length ? { _form: flat.formErrors } : {}) };
}
