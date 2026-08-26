const CASH_METHOD_SLUG: Record<string, string> = {
  Espèces: 'ESPECES',
  'Orange Money': 'ORANGE',
  Wave: 'WAVE',
  Virement: 'VIREMENT',
  Wizall: 'WIZALL',
};

/** Référence transaction pour encaissement en caisse (lisible dans les rapports). */
export function buildCashTransactionRef(paymentMethod: string, sessionId: string): string {
  const slug =
    CASH_METHOD_SLUG[paymentMethod.trim()] ??
    (paymentMethod
      .trim()
      .toUpperCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^A-Z0-9]+/g, '_')
      .replace(/^_|_$/g, '') || 'ESPECES');
  return `CAISSE-${slug}-${sessionId.slice(0, 8)}-${Date.now()}`;
}

/** Libellé du moyen de paiement à partir de la référence transaction. */
export function formatPaymentModeFromTransactionRef(ref: string | null | undefined): string {
  if (!ref?.trim()) return 'Espèces';
  const u = ref.toUpperCase();
  if (u.startsWith('CAISSE-')) {
    if (u.includes('ESPECES')) return 'Espèces';
    if (u.includes('ORANGE')) return 'Orange Money';
    if (u.includes('WAVE')) return 'Wave';
    if (u.includes('VIREMENT')) return 'Virement';
    if (u.includes('WIZALL')) return 'Wizall';
    return 'Caisse';
  }
  if (u.includes('WAVE')) return 'Wave';
  if (u.includes('ORANGE')) return 'Orange Money';
  if (u.includes('WIZALL')) return 'Wizall';
  if (u.includes('MTN')) return 'MTN Money';
  if (u.includes('MOOV')) return 'Moov Money';
  if (u.includes('WESTERN')) return 'Western Union';
  if (u.includes('VIREMENT')) return 'Virement';
  if (u.startsWith('PAYDUNYA-')) return 'Paiement en ligne';
  if (u.startsWith('SIM-')) return 'Paiement en ligne (simulation)';
  return 'Paiement enregistré';
}
