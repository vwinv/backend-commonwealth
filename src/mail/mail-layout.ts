/**
 * Gabarit e-mail « messagerie administrative » (Commonwealth School).
 * Styles en ligne pour compatibilité clients mail.
 */

/** Bleu marque des e-mails administratifs */
const MAIL_BLUE = '#216EC2';
const MAIL_BLUE_RECAP_BG = '#e9f5fc';

export type MailRecapRow = {
  label: string;
  value: string;
  /** Met en avant la valeur (ex. date d’échéance en rouge). */
  valueTone?: 'default' | 'blue' | 'red';
};

export type AdministrativeMailContent = {
  /** Ligne « De : » (adresse affichée, peut différer du MAIL_FROM technique). */
  fromDisplay: string;
  toEmail: string;
  toDisplayName: string | null;
  toPhone: string | null;
  /** Texte de l’objet (affiché en gras sur la ligne Objet). */
  subjectBold: string;
  /** Corps au-dessus du encadré récap (HTML déjà échappé côté appelant si besoin). */
  introHtml: string;
  /** Lignes du bloc récap (bord gauche bleu, fond bleu très clair). */
  recapRows: MailRecapRow[];
  /** Si renseigné, remplace le contenu du bloc récap (HTML contrôlé côté serveur uniquement). */
  recapHtmlOverride?: string;
  /** Paragraphes sous le récap (modes de paiement, etc.). */
  footerBodyHtml: string;
  /** Lignes dans le bandeau bleu de signature (HTML). */
  signatureBlockHtml: string;
  /** URL absolue du logo (optionnel). */
  logoUrl?: string | null;
  /** Téléphone service admin (bandeau signature). */
  adminPhone?: string;
  /** Numéro d’urgence (pied de page). */
  emergencyPhone?: string;
};

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function valueStyle(tone: MailRecapRow['valueTone']): string {
  if (tone === 'red') return 'color:#dc2626;font-weight:700;';
  if (tone === 'blue') return `color:${MAIL_BLUE};font-weight:700;`;
  return `color:${MAIL_BLUE};font-weight:700;`;
}

export function buildAdministrativeEmailHtml(c: AdministrativeMailContent): string {
  const toLine = [
    escapeHtml(c.toEmail),
    c.toDisplayName?.trim() ? escapeHtml(c.toDisplayName.trim()) : null,
    c.toPhone?.trim() ? escapeHtml(c.toPhone.trim()) : null,
  ]
    .filter(Boolean)
    .join(' · ');

  const recapRowsOnly = c.recapRows
    .map(
      (r) => `
    <tr>
      <td style="padding:6px 12px 6px 0;vertical-align:top;color:#64748b;font-size:13px;width:42%;">${escapeHtml(r.label)}</td>
      <td style="padding:6px 0;vertical-align:top;font-size:13px;${valueStyle(r.valueTone ?? 'blue')}">${r.value}</td>
    </tr>`,
    )
    .join('');

  const recapBlock = c.recapHtmlOverride?.trim()
    ? c.recapHtmlOverride.trim()
    : `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">${recapRowsOnly}</table>`;

  const logoBlock = c.logoUrl?.trim()
    ? `<img src="${escapeHtml(c.logoUrl.trim())}" alt="Commonwealth School" width="72" height="72" style="display:block;border:0;border-radius:4px;" />`
    : `<div style="width:72px;height:72px;border-radius:8px;background:#fef3c7;border:1px solid #fcd34d;display:flex;align-items:center;justify-content:center;font-size:10px;color:#92400e;text-align:center;padding:4px;">CWS</div>`;

  const adminPhone = c.adminPhone?.trim() || '(307) 555-0133';
  const emergency = c.emergencyPhone?.trim() || '(219) 555-0114';
  const generated = new Date().toLocaleString('fr-FR', {
    dateStyle: 'long',
    timeStyle: 'short',
  });

  return `<!DOCTYPE html>
<html lang="fr">
<head><meta charset="utf-8" /><meta name="viewport" content="width=device-width" /></head>
<body style="margin:0;padding:0;background:#e8edf4;">
  <div style="background:#e8edf4;padding:24px 12px;font-family:Arial,Helvetica,sans-serif;">
    <div style="max-width:640px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(15,23,42,0.08);border:1px solid #e2e8f0;">
      <div style="background:${MAIL_BLUE};color:#ffffff;text-align:center;padding:14px 16px;font-size:15px;font-weight:700;letter-spacing:0.02em;">
        Messagerie — Commonwealth School
      </div>
      <div style="padding:28px 24px 8px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
          <tr>
            <td width="88" valign="top">${logoBlock}</td>
            <td valign="middle" style="padding-left:16px;">
              <div style="font-size:24px;font-weight:800;color:${MAIL_BLUE};line-height:1.15;">Commonwealth School</div>
              <div style="font-size:14px;color:#64748b;margin-top:4px;">Service administratif</div>
            </td>
          </tr>
        </table>
        <div style="margin-top:22px;font-size:13px;color:#64748b;line-height:1.85;">
          <div><span style="color:#475569;font-weight:600;">De :</span>
            <a href="mailto:${escapeHtml(c.fromDisplay)}" style="color:${MAIL_BLUE};text-decoration:none;">${escapeHtml(c.fromDisplay)}</a>
          </div>
          <div><span style="color:#475569;font-weight:600;">À :</span> ${toLine}</div>
          <div><span style="color:#475569;font-weight:600;">Objet :</span> <strong style="color:#0f172a;">${escapeHtml(c.subjectBold)}</strong></div>
        </div>
        <hr style="border:none;border-top:1px solid #e2e8f0;margin:22px 0 18px;" />
        <div style="font-size:15px;color:#1e293b;line-height:1.7;">${c.introHtml}</div>
        <div style="margin-top:22px;border-left:5px solid ${MAIL_BLUE};background:${MAIL_BLUE_RECAP_BG};border-radius:0 10px 10px 0;padding:16px 18px;">
          ${recapBlock}
        </div>
        <div style="margin-top:20px;font-size:15px;color:#1e293b;line-height:1.7;">${c.footerBodyHtml}</div>
        <p style="margin:22px 0 0;font-size:15px;color:#1e293b;">Cordialement,</p>
        <div style="margin-top:16px;background:${MAIL_BLUE};color:#ffffff;border-radius:10px;padding:18px 20px;font-size:14px;line-height:1.65;">
          ${c.signatureBlockHtml}
        </div>
      </div>
      <div style="padding:8px 24px 28px;text-align:center;font-size:12px;color:#64748b;line-height:1.6;">
        Commonwealth School · Numéro d’urgence élève : ${escapeHtml(emergency)}<br />
        <span style="color:#94a3b8;">Document généré le ${escapeHtml(generated)}</span>
      </div>
    </div>
    <div style="max-width:640px;margin:12px auto 0;text-align:center;font-size:11px;color:#94a3b8;">
      Service administratif · ${escapeHtml(adminPhone)}
    </div>
  </div>
</body>
</html>`;
}

export function buildAdministrativeEmailText(parts: {
  subjectBold: string;
  fromDisplay: string;
  toLine: string;
  introText: string;
  recapLines: string[];
  footerText: string;
  signatureText: string;
  emergencyPhone?: string;
}): string {
  const emergency = parts.emergencyPhone?.trim() || '(219) 555-0114';
  const generated = new Date().toLocaleString('fr-FR', { dateStyle: 'long', timeStyle: 'short' });
  return [
    'Messagerie — Commonwealth School',
    '',
    'Commonwealth School — Service administratif',
    '',
    `De : ${parts.fromDisplay}`,
    `À : ${parts.toLine}`,
    `Objet : ${parts.subjectBold}`,
    '---',
    parts.introText,
    '',
    ...parts.recapLines,
    '',
    parts.footerText,
    '',
    'Cordialement,',
    '',
    parts.signatureText,
    '',
    `Commonwealth School · Numéro d'urgence élève : ${emergency}`,
    `Document généré le ${generated}`,
  ].join('\n');
}
