/** Gabarit facture Commonwealth (scolarité / mensualité) — styles inline pour impression / PDF. */

const BRAND = '#216EC2';
const BRAND_SOFT = '#e9f5fc';
const ORANGE_BADGE = '#ea580c';

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export type ParentInvoiceLine = {
  description: string;
  qty: string;
  unitPrice: string;
  amount: string;
};

export type ParentInvoiceHtmlInput = {
  documentTitle: string;
  schoolDisplayName: string;
  headerSubline: string;
  contactEmail: string;
  administrationEmail: string;
  emergencyPhone: string;
  paymentModesLine: string;
  logoDataUri: string | null;
  invoiceNumber: string;
  issueDateFr: string;
  dueDateFr: string;
  schoolYearLine: string;
  studentNameWithLevel: string;
  matriculeLine: string;
  billedToTitle: string;
  billedAddress: string;
  lines: ParentInvoiceLine[];
  totalAmount: string;
  parentContactLine: string;
  generatedDateFr: string;
};

export function buildParentInvoiceHtml(input: ParentInvoiceHtmlInput): string {
  const logo =
    input.logoDataUri?.trim() ?
      `<img src="${esc(input.logoDataUri.trim())}" alt="" width="72" height="72" style="display:block;border:0;border-radius:4px;object-fit:contain;" />`
    : `<div style="width:72px;height:72px;border-radius:4px;background:${BRAND_SOFT};border:1px solid #c5e3f4;"></div>`;

  const rows = input.lines
    .map(
      (l) => `
      <tr>
        <td style="padding:10px 8px;border-bottom:1px solid #e2e8f0;font-size:13px;color:#0f172a;">${esc(l.description)}</td>
        <td style="padding:10px 8px;border-bottom:1px solid #e2e8f0;font-size:13px;color:#0f172a;text-align:center;width:48px;">${esc(l.qty)}</td>
        <td style="padding:10px 8px;border-bottom:1px solid #e2e8f0;font-size:13px;color:#0f172a;text-align:right;white-space:nowrap;">${esc(l.unitPrice)}</td>
        <td style="padding:10px 8px;border-bottom:1px solid #e2e8f0;font-size:13px;font-weight:700;color:${BRAND};text-align:right;white-space:nowrap;">${esc(l.amount)}</td>
      </tr>`,
    )
    .join('');

  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(input.documentTitle)} — ${esc(input.invoiceNumber)}</title>
  <style>
    @page { margin: 18mm; size: A4; }
    body { margin:0; padding:24px; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; color:#0f172a; background:#fff; }
    @media print { body { padding: 0; } .no-print { display:none !important; } }
  </style>
</head>
<body>
  <div style="max-width:820px;margin:0 auto;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-bottom:16px;">
      <tr>
        <td valign="top" style="width:88px;">${logo}</td>
        <td valign="top" align="right" style="padding-left:16px;">
          <div style="font-size:20px;font-weight:800;color:${BRAND};letter-spacing:-0.02em;">${esc(input.schoolDisplayName)}</div>
          <div style="margin-top:6px;font-size:12px;color:#64748b;line-height:1.45;">${esc(input.headerSubline)}</div>
        </td>
      </tr>
    </table>
    <div style="height:1px;background:#e2e8f0;margin:0 0 20px;"></div>

    <h1 style="margin:0 0 20px;font-size:26px;font-weight:800;color:${BRAND};letter-spacing:-0.02em;">${esc(input.documentTitle)}</h1>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-bottom:24px;">
      <tr>
        <td valign="top" style="width:50%;padding-right:12px;">
          <div style="font-size:10px;font-weight:700;letter-spacing:0.06em;color:#64748b;text-transform:uppercase;margin-bottom:4px;">Facture n°</div>
          <div style="font-size:15px;font-weight:700;color:#0f172a;margin-bottom:14px;">${esc(input.invoiceNumber)}</div>
          <div style="font-size:10px;font-weight:700;letter-spacing:0.06em;color:#64748b;text-transform:uppercase;margin-bottom:4px;">Élève</div>
          <div style="font-size:15px;font-weight:700;color:#0f172a;">${esc(input.studentNameWithLevel)}</div>
          <div style="margin-top:4px;font-size:12px;color:#64748b;">${esc(input.matriculeLine)}</div>
          <div style="margin-top:14px;font-size:10px;font-weight:700;letter-spacing:0.06em;color:#64748b;text-transform:uppercase;margin-bottom:4px;">Facturé à</div>
          <div style="font-size:14px;font-weight:600;color:#0f172a;">${esc(input.billedToTitle)}</div>
          <div style="margin-top:6px;font-size:13px;color:#475569;line-height:1.5;white-space:pre-wrap;">${esc(input.billedAddress)}</div>
        </td>
        <td valign="top" style="width:50%;padding-left:12px;">
          <div style="font-size:10px;font-weight:700;letter-spacing:0.06em;color:#64748b;text-transform:uppercase;margin-bottom:4px;">Date d'émission</div>
          <div style="font-size:14px;font-weight:600;color:#0f172a;margin-bottom:14px;">${esc(input.issueDateFr)}</div>
          <div style="font-size:10px;font-weight:700;letter-spacing:0.06em;color:#64748b;text-transform:uppercase;margin-bottom:6px;">Date d'échéance</div>
          <div style="display:inline-block;background:${ORANGE_BADGE};color:#fff;font-weight:700;font-size:13px;padding:6px 14px;border-radius:999px;margin-bottom:14px;">${esc(input.dueDateFr)}</div>
          <div style="font-size:10px;font-weight:700;letter-spacing:0.06em;color:#64748b;text-transform:uppercase;margin-bottom:4px;">Année scolaire</div>
          <div style="font-size:14px;font-weight:600;color:#0f172a;">${esc(input.schoolYearLine)}</div>
        </td>
      </tr>
    </table>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;">
      <thead>
        <tr style="background:${BRAND_SOFT};">
          <th align="left" style="padding:10px 8px;font-size:11px;font-weight:700;color:${BRAND};text-transform:uppercase;letter-spacing:0.04em;">Description</th>
          <th align="center" style="padding:10px 8px;font-size:11px;font-weight:700;color:${BRAND};text-transform:uppercase;width:48px;">Qté</th>
          <th align="right" style="padding:10px 8px;font-size:11px;font-weight:700;color:${BRAND};text-transform:uppercase;">Prix unitaire</th>
          <th align="right" style="padding:10px 8px;font-size:11px;font-weight:700;color:${BRAND};text-transform:uppercase;">Montant</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-top:0;">
      <tr>
        <td style="background:${BRAND};color:#fff;padding:14px 16px;font-size:15px;font-weight:800;">Total à payer</td>
        <td align="right" style="background:${BRAND};color:#fff;padding:14px 16px;font-size:16px;font-weight:800;white-space:nowrap;">${esc(input.totalAmount)}</td>
      </tr>
    </table>

    <div style="margin-top:22px;font-size:12px;color:#475569;line-height:1.55;">
      <div style="margin-bottom:6px;"><span style="color:#64748b;font-weight:600;">Modes de paiement acceptés</span> — ${esc(input.paymentModesLine)}</div>
      <div><span style="color:#64748b;font-weight:600;">Contact parent</span> — ${esc(input.parentContactLine)}</div>
    </div>

    <div style="margin-top:22px;padding-left:14px;border-left:4px solid ${BRAND};font-size:12px;color:#475569;line-height:1.6;">
      <p style="margin:0 0 6px;">Merci de mentionner le numéro de facture <strong style="color:#0f172a;">${esc(input.invoiceNumber)}</strong> lors de votre règlement.</p>
      <p style="margin:0 0 6px;">Tout paiement reçu après la date d'échéance entraînera des frais de retard.</p>
      <p style="margin:0;">Pour toute question : <a href="mailto:${esc(input.administrationEmail)}" style="color:${BRAND};font-weight:600;">${esc(input.administrationEmail)}</a></p>
    </div>

    <div style="margin-top:28px;padding-top:16px;border-top:1px solid #e2e8f0;text-align:center;font-size:11px;color:#94a3b8;line-height:1.5;">
      ${esc(input.schoolDisplayName)} · Numéro d'urgence élève : ${esc(input.emergencyPhone)}<br />
      Document généré le ${esc(input.generatedDateFr)}
    </div>
  </div>
</body>
</html>`;
}

export function formatXofFromCents(cents: number): string {
  return new Intl.NumberFormat('fr-FR', {
    style: 'currency',
    currency: 'XOF',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

export function tuitionAnnualDueDateFr(schoolYear: string): string {
  const m = schoolYear.trim().match(/^(\d{4})/);
  const y = m ? parseInt(m[1]!, 10) : new Date().getFullYear();
  return new Date(y, 8, 30).toLocaleDateString('fr-FR', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

export function monthEndDateFr(year: number, month: number): string {
  return new Date(year, month, 0).toLocaleDateString('fr-FR', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

export function schoolTrimesterFromMonth(month: number): 1 | 2 | 3 {
  const idx = ((month - 9 + 12) % 12) + 1;
  const t = Math.ceil(idx / 3);
  return (t > 3 ? 3 : t) as 1 | 2 | 3;
}

export { stableInvoiceNumber } from '../common/invoice-number';

export function matriculeFromEnrollmentId(enrollmentId: string): string {
  const compact = enrollmentId.replace(/-/g, '').toUpperCase();
  return `MD${compact.slice(0, 6)}`;
}
