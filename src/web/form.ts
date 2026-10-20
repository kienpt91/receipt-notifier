import { CURRENCIES, isCurrency, majorToMinor } from '../shared/money.js';
import { ReceiptRequest, fieldErrors, type FieldErrors } from '../shared/receiptSchema.js';

// Browser side of the shared schema. This is UX only: the API re-validates with the same
// ReceiptRequest, so bypassing this file (curl, devtools) changes nothing.

const form = document.querySelector<HTMLFormElement>('#receipt-form')!;
const submit = form.querySelector<HTMLButtonElement>('button[type=submit]')!;
const status = document.querySelector<HTMLParagraphElement>('#status')!;
const currencySelect = form.querySelector<HTMLSelectElement>('[name=currency]')!;

for (const c of CURRENCIES) currencySelect.add(new Option(c, c));

function showErrors(errors: FieldErrors) {
  for (const el of form.querySelectorAll<HTMLElement>('[data-error-for]')) {
    const field = el.dataset.errorFor as keyof FieldErrors;
    el.textContent = errors[field]?.join(', ') ?? '';
  }
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (submit.disabled) return; // prevents double submit; the server dedupes regardless
  const data = new FormData(form);
  const currency = String(data.get('currency'));

  // The human types "12.34"; the system only ever sees minor units.
  let amountMinor = '';
  const amountErrors: string[] = [];
  try {
    if (isCurrency(currency)) amountMinor = majorToMinor(String(data.get('amount')), currency).toString();
  } catch (err) {
    amountErrors.push((err as Error).message);
  }

  const parsed = ReceiptRequest.safeParse({
    recipientEmail: data.get('recipientEmail'),
    amountMinor,
    currency,
    paymentReference: data.get('paymentReference'),
  });
  if (!parsed.success || amountErrors.length) {
    const errors = parsed.success ? {} : fieldErrors(parsed.error);
    if (amountErrors.length) errors.amountMinor = amountErrors;
    showErrors(errors);
    status.textContent = '';
    return;
  }
  showErrors({});

  submit.disabled = true;
  status.textContent = 'Sending…';
  try {
    const res = await fetch('/admin/receipts', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${data.get('adminToken')}` },
      body: JSON.stringify(parsed.data),
    });
    const body = await res.json();
    if (res.status === 400) showErrors(body.errors); // same error shape as the client-side check
    status.textContent = res.ok ? `Receipt ${body.status}` : `Error ${res.status}: ${body.error ?? 'invalid input'}`;
  } catch {
    status.textContent = 'Network error, safe to retry: the same reference is never sent twice';
  } finally {
    submit.disabled = false;
  }
});
