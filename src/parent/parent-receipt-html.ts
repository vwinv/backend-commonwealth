/** Reçu de paiement (factures déjà payées) — styles inline pour PDF. */

const NAVY = '#0f2947';
const BRAND = '#216EC2';
const BRAND_SOFT = '#e9f5fc';
const GREEN = '#059669';
const GREEN_SOFT = '#ecfdf5';
const GREEN_BORDER = '#34d399';
const TAG_ORANGE_BG = '#ffedd5';
const TAG_ORANGE_TEXT = '#9a3412';

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export type ParentReceiptLine = { description: string; amount: string };

export type ParentReceiptHtmlInput = {
  schoolDisplayName: string;
  headerSubline: string;
  logoDataUri: string | null;
  receiptNumber: string;
  studentNameWithLevel: string;
  matriculeLine: string;
  enrollmentDateFr: string;
  billedToTitle: string;
  billedAddress: string;
  paymentDateFr: string;
  paymentModeLine: string;
  amountHighlight: string;
  settlementLine: string;
  lines: ParentReceiptLine[];
  totalPaid: string;
  administrationEmail: string;
  emergencyPhone: string;
  generatedDateFr: string;
  medicalTags: string[];
};

export function formatPaymentModeFromTransactionRef(ref: string | null | undefined): string {
  if (!ref?.trim()) return 'Paiement enregistré';
  const u = ref.toUpperCase();
  if (u.includes('WAVE')) return 'Wave';
  if (u.includes('ORANGE')) return 'Orange Money';
  if (u.includes('WIZALL')) return 'Wizall';
  if (u.includes('WESTERN')) return 'Western Union';
  if (u.includes('VIREMENT')) return 'Virement bancaire';
  if (u.startsWith('SIM-')) return 'Paiement en ligne (simulation)';
  return 'Paiement enregistré';
}

export function parseMedicalTags(allergies: string | null | undefined): string[] {
  if (!allergies?.trim()) return [];
  return allergies
    .split(/[,;\n\r]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 8);
}

export function stableReceiptNumber(prefixYear: number, entityId: string): string {
  const hex = entityId.replace(/-/g, '');
  const slice = (hex.length >= 8 ? hex.slice(0, 8) : hex.slice(-8)) || '0';
  const n = Number.parseInt(slice, 16) % 100000;
  return `REC-${prefixYear}-${String(n).padStart(5, '0')}`;
}

export function buildParentReceiptHtml(input: ParentReceiptHtmlInput): string {
  const logo =
    input.logoDataUri?.trim() ?
      `<img src="${esc(input.logoDataUri.trim())}" alt="" width="72" height="72" style="display:block;border:0;border-radius:4px;object-fit:contain;" />`
    : `<div style="width:72px;height:72px;border-radius:4px;background:${BRAND_SOFT};border:1px solid #c5e3f4;"></div>`;

  const rows = input.lines
    .map(
      (l) => `
      <tr>
        <td style="padding:12px 10px;border-bottom:1px solid #e2e8f0;font-size:13px;color:#0f172a;">${esc(l.description)}</td>
        <td style="padding:12px 10px;border-bottom:1px solid #e2e8f0;font-size:13px;font-weight:600;color:${NAVY};text-align:right;white-space:nowrap;">${esc(l.amount)}</td>
      </tr>`,
    )
    .join('');

  const medical =
    input.medicalTags.length ?
      `<div style="margin-top:22px;">
        <div style="font-size:10px;font-weight:700;letter-spacing:0.08em;color:#64748b;text-transform:uppercase;margin-bottom:10px;">Informations médicales à noter</div>
        <div style="display:flex;flex-wrap:wrap;gap:8px;">
          ${input.medicalTags
            .map(
              (t) =>
                `<span style="display:inline-block;background:${TAG_ORANGE_BG};color:${TAG_ORANGE_TEXT};font-size:12px;font-weight:600;padding:8px 14px;border-radius:999px;">${esc(t)}</span>`,
            )
            .join('')}
        </div>
      </div>`
    : '';

  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Reçu de paiement — ${esc(input.receiptNumber)}</title>
  <style>
    @page { margin: 16mm; size: A4; }
    body { margin:0; padding:22px 24px; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; color:#0f172a; background:#fff; }
  </style>
</head>
<body>
  <div style="max-width:820px;margin:0 auto;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-bottom:14px;">
      <tr>
        <td valign="top" style="width:88px;">${logo}</td>
        <td valign="top" style="padding-left:14px;">
          <div style="font-size:19px;font-weight:800;color:${NAVY};letter-spacing:-0.02em;">${esc(input.schoolDisplayName)}</div>
          <div style="margin-top:6px;font-size:12px;color:#64748b;line-height:1.45;">${esc(input.headerSubline)}</div>
        </td>
        <td valign="top" align="right" style="width:120px;">
          <div style="display:inline-block;border:2px solid ${GREEN_BORDER};color:${GREEN};font-weight:800;font-size:12px;letter-spacing:0.12em;padding:8px 16px;border-radius:999px;">PAYÉ</div>
        </td>
      </tr>
    </table>
    <div style="height:1px;background:#e2e8f0;margin:0 0 18px;"></div>

    <h1 style="margin:0 0 18px;font-size:28px;font-weight:800;color:${BRAND};letter-spacing:-0.02em;">Reçu de paiement</h1>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-bottom:20px;">
      <tr>
        <td valign="top" style="width:50%;padding-right:14px;">
          <div style="font-size:10px;font-weight:700;letter-spacing:0.06em;color:#64748b;text-transform:uppercase;margin-bottom:4px;">Reçu n°</div>
          <div style="font-size:15px;font-weight:700;color:#0f172a;margin-bottom:14px;">${esc(input.receiptNumber)}</div>
          <div style="font-size:10px;font-weight:700;letter-spacing:0.06em;color:#64748b;text-transform:uppercase;margin-bottom:4px;">Élève</div>
          <div style="font-size:15px;font-weight:700;color:#0f172a;">${esc(input.studentNameWithLevel)}</div>
          <div style="margin-top:6px;font-size:12px;color:#64748b;line-height:1.5;">${esc(input.matriculeLine)} · <span style="color:#64748b;">Date d'inscription :</span> ${esc(input.enrollmentDateFr)}</div>
          <div style="margin-top:14px;font-size:10px;font-weight:700;letter-spacing:0.06em;color:#64748b;text-transform:uppercase;margin-bottom:4px;">Reçu de</div>
          <div style="font-size:14px;font-weight:600;color:#0f172a;">${esc(input.billedToTitle)}</div>
          <div style="margin-top:6px;font-size:13px;color:#475569;line-height:1.5;white-space:pre-wrap;">${esc(input.billedAddress)}</div>
        </td>
        <td valign="top" style="width:50%;padding-left:14px;">
          <div style="font-size:10px;font-weight:700;letter-spacing:0.06em;color:#64748b;text-transform:uppercase;margin-bottom:4px;">Date de paiement</div>
          <div style="font-size:14px;font-weight:600;color:#0f172a;margin-bottom:14px;">${esc(input.paymentDateFr)}</div>
          <div style="font-size:10px;font-weight:700;letter-spacing:0.06em;color:#64748b;text-transform:uppercase;margin-bottom:4px;">Mode de paiement</div>
          <div style="font-size:14px;font-weight:600;color:#0f172a;">${esc(input.paymentModeLine)}</div>
        </td>
      </tr>
    </table>

    <div style="background:${GREEN_SOFT};border:1px solid #a7f3d0;border-radius:10px;padding:16px 18px;margin-bottom:20px;text-align:center;">
      <div style="font-size:12px;font-weight:600;color:${GREEN};margin-bottom:6px;">${esc(input.settlementLine)}</div>
      <div style="font-size:26px;font-weight:800;color:${GREEN};letter-spacing:-0.02em;">${esc(input.amountHighlight)}</div>
    </div>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;">
      <thead>
        <tr style="background:${BRAND_SOFT};">
          <th align="left" style="padding:10px 10px;font-size:11px;font-weight:700;color:${BRAND};text-transform:uppercase;">Description</th>
          <th align="right" style="padding:10px 10px;font-size:11px;font-weight:700;color:${BRAND};text-transform:uppercase;width:140px;">Montant</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-top:0;">
      <tr>
        <td style="background:${BRAND};color:#fff;padding:14px 16px;font-size:15px;font-weight:800;">Total payé</td>
        <td align="right" style="background:${BRAND};color:#fff;padding:14px 16px;font-size:16px;font-weight:800;white-space:nowrap;">${esc(input.totalPaid)}</td>
      </tr>
    </table>

    ${medical}

    <div style="margin-top:22px;padding-left:14px;border-left:4px solid ${BRAND};font-size:12px;color:#475569;line-height:1.65;">
      <p style="margin:0;">Ce reçu fait foi de paiement. Veuillez le conserver précieusement. Pour toute question : <a href="mailto:${esc(input.administrationEmail)}" style="color:${BRAND};font-weight:600;">${esc(input.administrationEmail)}</a></p>
    </div>

    <div style="margin-top:26px;padding-top:14px;border-top:1px solid #e2e8f0;text-align:center;font-size:11px;color:#94a3b8;line-height:1.5;">
      ${esc(input.schoolDisplayName)} · Numéro d'urgence élève : ${esc(input.emergencyPhone)}<br />
      Document généré le ${esc(input.generatedDateFr)}
    </div>
  </div>
</body>
</html>`;
}
