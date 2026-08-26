/** Gabarit PDF programme parent — styles inline pour Puppeteer. */

const BRAND = '#216EC2';
const BRAND_SOFT = '#e9f5fc';

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export type ParentProgrammePdfEvent = {
  title: string;
  description: string;
  dateLabel: string;
  dayNum: number;
  dayAbbr: string;
  location: string;
  assignedStaff: string;
  categoryLabel: string;
  categoryColor: string;
  categoryBgColor: string;
  status: string;
  statusLabel: string;
  levelLabels: string[];
};

export type ParentProgrammePdfGroup = {
  monthLabel: string;
  events: ParentProgrammePdfEvent[];
};

export type ParentProgrammeHtmlInput = {
  schoolDisplayName: string;
  headerSubline: string;
  logoDataUri: string | null;
  schoolYear: string;
  generatedDateFr: string;
  filterLabel: string | null;
  stats: { total: number; upcoming: number; inProgress: number; completed: number };
  groups: ParentProgrammePdfGroup[];
};

function statusStyle(status: string): { bg: string; color: string } {
  if (status === 'IN_PROGRESS') return { bg: '#FFF3E0', color: '#F9994B' };
  if (status === 'COMPLETED') return { bg: '#E8F5E9', color: '#2E7D32' };
  return { bg: '#F1F5F9', color: '#64748B' };
}

function eventCard(event: ParentProgrammePdfEvent): string {
  const iconColor = event.categoryColor?.trim() || BRAND;
  const iconBg = event.categoryBgColor?.trim() || BRAND_SOFT;
  const st = statusStyle(event.status);
  const levels = event.levelLabels.length
    ? event.levelLabels
        .map(
          (l) =>
            `<span style="display:inline-block;margin:0 6px 6px 0;padding:3px 8px;border:1px solid #e2e8f0;border-radius:6px;background:#f8fafc;font-size:10px;font-weight:600;color:#475569;">${esc(l)}</span>`,
        )
        .join('')
    : '';

  const meta: string[] = [`<span>${esc(event.dateLabel)}</span>`];
  if (event.location) meta.push(`<span>${esc(event.location)}</span>`);
  if (event.assignedStaff) meta.push(`<span>${esc(event.assignedStaff)}</span>`);

  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 10px;border:1px solid ${esc(iconColor)}40;border-radius:10px;overflow:hidden;">
      <tr>
        <td valign="middle" style="width:56px;padding:12px 8px;background:${esc(iconBg)};color:${esc(iconColor)};text-align:center;border-right:1px solid ${esc(iconColor)}30;">
          <div style="font-size:20px;font-weight:800;line-height:1;">${esc(String(event.dayNum))}</div>
          <div style="margin-top:4px;font-size:9px;font-weight:700;letter-spacing:0.04em;opacity:0.85;">${esc(event.dayAbbr)}</div>
        </td>
        <td valign="top" style="padding:12px 14px;">
          <div>
            <span style="display:inline-block;margin:0 6px 4px 0;padding:2px 10px;border-radius:999px;background:${esc(iconBg)};color:${esc(iconColor)};font-size:10px;font-weight:700;">${esc(event.categoryLabel)}</span>
            <span style="display:inline-block;margin:0 0 4px;padding:2px 10px;border-radius:999px;background:${st.bg};color:${st.color};font-size:10px;font-weight:700;">${esc(event.statusLabel)}</span>
          </div>
          <div style="margin-top:4px;font-size:14px;font-weight:800;color:#0f172a;">${esc(event.title)}</div>
          ${event.description ? `<div style="margin-top:4px;font-size:12px;color:#475569;line-height:1.45;">${esc(event.description)}</div>` : ''}
          <div style="margin-top:8px;font-size:11px;color:#64748b;line-height:1.45;">${meta.join(' · ')}</div>
          ${levels ? `<div style="margin-top:8px;">${levels}</div>` : ''}
        </td>
      </tr>
    </table>`;
}

export function buildParentProgrammeHtml(input: ParentProgrammeHtmlInput): string {
  const logo = input.logoDataUri?.trim()
    ? `<img src="${esc(input.logoDataUri.trim())}" alt="" width="72" height="72" style="display:block;border:0;border-radius:4px;object-fit:contain;" />`
    : `<div style="width:72px;height:72px;border-radius:4px;background:${BRAND_SOFT};border:1px solid #c5e3f4;"></div>`;

  const groupsHtml = input.groups.length
    ? input.groups
        .map(
          (g) => `
      <section style="margin-bottom:22px;">
        <h2 style="margin:0 0 10px;font-size:15px;font-weight:800;color:#1e293b;">${esc(g.monthLabel)}</h2>
        ${g.events.map(eventCard).join('')}
      </section>`,
        )
        .join('')
    : `<p style="margin:24px 0;text-align:center;font-size:13px;color:#64748b;">Aucun événement à afficher pour cette sélection.</p>`;

  const filterLine = input.filterLabel
    ? `<div style="margin-top:4px;font-size:12px;color:#64748b;">Catégorie : ${esc(input.filterLabel)}</div>`
    : '';

  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Programme — ${esc(input.schoolYear)}</title>
  <style>
    @page { margin: 16mm; size: A4; }
    body { margin:0; padding:24px; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; color:#0f172a; background:#fff; }
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

    <h1 style="margin:0;font-size:24px;font-weight:800;color:${BRAND};letter-spacing:-0.02em;">Programme</h1>
    <div style="margin-top:6px;font-size:13px;color:#475569;">Année scolaire ${esc(input.schoolYear)} — événements des niveaux de vos enfants</div>
    ${filterLine}

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;border-spacing:8px 0;margin:18px -8px 22px;">
      <tr>
        <td style="width:25%;padding:12px;border:1px solid #c5e3f4;border-radius:10px;background:#fff;">
          <div style="font-size:10px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.04em;">Programmes</div>
          <div style="margin-top:4px;font-size:22px;font-weight:800;color:#0f172a;">${esc(String(input.stats.total))}</div>
        </td>
        <td style="width:25%;padding:12px;border:1px solid #c5e3f4;border-radius:10px;background:#fff;">
          <div style="font-size:10px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.04em;">À venir</div>
          <div style="margin-top:4px;font-size:22px;font-weight:800;color:#0f172a;">${esc(String(input.stats.upcoming))}</div>
        </td>
        <td style="width:25%;padding:12px;border:1px solid #c5e3f4;border-radius:10px;background:#fff;">
          <div style="font-size:10px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.04em;">En cours</div>
          <div style="margin-top:4px;font-size:22px;font-weight:800;color:#0f172a;">${esc(String(input.stats.inProgress))}</div>
        </td>
        <td style="width:25%;padding:12px;border:1px solid #c5e3f4;border-radius:10px;background:#fff;">
          <div style="font-size:10px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.04em;">Terminés</div>
          <div style="margin-top:4px;font-size:22px;font-weight:800;color:#0f172a;">${esc(String(input.stats.completed))}</div>
        </td>
      </tr>
    </table>

    ${groupsHtml}

    <div style="margin-top:28px;padding-top:16px;border-top:1px solid #e2e8f0;text-align:center;font-size:11px;color:#94a3b8;line-height:1.5;">
      ${esc(input.schoolDisplayName)}<br />
      Document généré le ${esc(input.generatedDateFr)}
    </div>
  </div>
</body>
</html>`;
}
