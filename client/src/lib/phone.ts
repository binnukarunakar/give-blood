// Phone display formatting. Jurisdiction is US-only, so the
// one shape worth grouping is E.164 NANP: +15550100001 -> "+1 555 010 0001".
//
// Display only. Every `tel:` href keeps the raw value the server sent — a
// dialler wants digits, not spaces — and anything that is not an 11-digit +1
// number (an international number, or a placeholder like DONOR_PHONE) is
// returned untouched rather than mangled into a shape it does not have.
const NANP_E164 = /^\+1(\d{3})(\d{3})(\d{4})$/;

export function formatPhone(phone: string): string {
  const parts = NANP_E164.exec(phone);
  if (parts === null) return phone;
  return `+1 ${parts[1] ?? ''} ${parts[2] ?? ''} ${parts[3] ?? ''}`;
}
