/** Numéro de facture stable (aligné PDF parent). */
export function stableInvoiceNumber(prefixYear: number, entityId: string): string {
  const hex = entityId.replace(/-/g, '').slice(-8);
  const n = Number.parseInt(hex, 16) % 100000;
  return `INV-${prefixYear}-${String(n).padStart(5, '0')}`;
}

/** Normalise la saisie recherche facture (espaces, NV- → INV-). */
export function normalizeInvoiceSearchQuery(raw: string): string {
  let q = raw.trim().toUpperCase().replace(/\s+/g, '');
  if (q.startsWith('NV-')) q = `INV-${q.slice(3)}`;
  return q;
}

function invoiceNumericSuffix(invoiceNumber: string): string {
  const parts = invoiceNumber.toUpperCase().split('-');
  return parts[parts.length - 1] ?? '';
}

function invoiceYear(invoiceNumber: string): string | null {
  const m = invoiceNumber.toUpperCase().match(/^INV-(\d{4})-/);
  return m?.[1] ?? null;
}

function padInvoiceSuffix(digits: string): string {
  return digits.replace(/\D/g, '').padStart(5, '0');
}

/**
 * Correspondance facture : numéro complet, suffixe seul (56883), année+suffixe (2026-56883), etc.
 */
export function invoiceNumberMatchesSearch(invoiceNumber: string, needleRaw: string): boolean {
  const inv = invoiceNumber.toUpperCase();
  const q = normalizeInvoiceSearchQuery(needleRaw);
  if (!q) return false;
  if (inv === q) return true;

  const invSuffix = invoiceNumericSuffix(inv);
  const invYear = invoiceYear(inv);

  if (/^\d+$/.test(q)) {
    const padded = padInvoiceSuffix(q);
    return invSuffix === padded;
  }

  const yearSuffix = q.match(/^(\d{4})-(\d+)$/);
  if (yearSuffix) {
    const [, year, num] = yearSuffix;
    return invYear === year && invSuffix === padInvoiceSuffix(num);
  }

  const full = q.match(/^INV-(\d{4})-(\d+)$/);
  if (full) {
    const [, year, num] = full;
    return inv === `INV-${year}-${padInvoiceSuffix(num)}`;
  }

  const invOnlySuffix = q.match(/^INV-(\d+)$/);
  if (invOnlySuffix) {
    return invSuffix === padInvoiceSuffix(invOnlySuffix[1]);
  }

  return false;
}
