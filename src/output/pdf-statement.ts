import PDFDocument from 'pdfkit';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { MONTH_NAMES_FR } from '../config.js';
import type { CsvRow } from '../stripe/reports.js';

/**
 * Relevé de compte Stripe mensuel, construit à partir des trois rapports
 * financiers Stripe (Financial Reports) :
 *   - balance.summary.1                       → rapport de solde
 *   - payouts.itemized.3                      → rapport des virements
 *   - balance_change_from_activity.itemized.3 → rapport des transactions / frais
 *
 * C'est le document "relevé bancaire" du compte Stripe (512004) demandé par
 * le cabinet comptable pour les rapprochements bancaires.
 */

const COLORS = {
  primary: '#1a2b4a',
  accent: '#2980b9',
  lightBg: '#f4f7fa',
  border: '#dce4ec',
  text: '#333333',
  textLight: '#666666',
  white: '#ffffff',
  boldBg: '#e8eef5',
};

export interface StripeStatementData {
  year: number;
  month: number;
  accountId: string;
  generatedAt: string; // ISO
  balance: CsvRow[];   // balance.summary.1
  payouts: CsvRow[];   // payouts.itemized.3
  activity: CsvRow[];  // balance_change_from_activity.itemized.3
}

const BALANCE_ORDER = [
  'starting_balance', 'activity_gross', 'activity_fee', 'activity',
  'payouts_gross', 'payouts_fee', 'payouts', 'ending_balance',
];

const BALANCE_LABELS: Record<string, string> = {
  starting_balance: "Solde d'ouverture",
  activity_gross: 'Activité brute (avant frais)',
  activity_fee: 'Frais Stripe',
  activity: 'Activité nette',
  payouts_gross: 'Virements vers la banque',
  payouts_fee: 'Frais sur virements',
  payouts: 'Total virements',
  ending_balance: 'Solde de clôture',
};

const CATEGORY_LABELS: Record<string, string> = {
  charge: 'Paiement',
  refund: 'Remboursement',
  refund_failure: 'Échec remboursement',
  fee: 'Frais Stripe',
  dispute: 'Litige',
  dispute_reversal: 'Litige annulé',
  payout: 'Virement',
  payout_reversal: 'Virement annulé',
  payout_minimum_balance_hold: 'Solde retenu',
  payout_minimum_balance_release: 'Solde libéré',
  adjustment: 'Ajustement',
  other_adjustment: 'Ajustement',
  transfer: 'Transfert',
  transfer_reversal: 'Transfert annulé',
  partial_capture_reversal: 'Capture partielle',
  tax: 'Taxe',
  topup: 'Approvisionnement',
  topup_reversal: 'Approvisionnement annulé',
  platform_earning: 'Revenu plateforme',
  advance: 'Avance',
  advance_funding: 'Avance',
  anticipation_repayment: 'Remboursement avance',
};

const CATEGORY_ORDER = Object.keys(CATEGORY_LABELS);

const PAYOUT_STATUS: Record<string, string> = {
  paid: 'Payé',
  pending: 'En attente',
  in_transit: 'En transit',
  canceled: 'Annulé',
  failed: 'Échoué',
};

// ─── Formatting ───────────────────────────────────────────

function num(v: string | undefined): number {
  const n = parseFloat(v ?? '');
  return Number.isFinite(n) ? n : 0;
}

function money(n: number, currency = 'eur'): string {
  const sign = n < 0 ? '-' : '';
  const [int, dec] = Math.abs(n).toFixed(2).split('.');
  const intFmt = int.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${sign}${intFmt},${dec} ${currency.toUpperCase()}`;
}

/** "2026-09-07 02:01:04" → "07/09/2026 02:01" */
function fmtDateTime(s: string | undefined): string {
  const m = (s ?? '').match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/);
  if (!m) return s ?? '';
  return m[4] ? `${m[3]}/${m[2]}/${m[1]} ${m[4]}:${m[5]}` : `${m[3]}/${m[2]}/${m[1]}`;
}

/** "2026-09-07 ..." → "07/09/2026" */
function fmtDate(s: string | undefined): string {
  const m = (s ?? '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : (s ?? '');
}

function fmtIsoDate(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;
}

function categoryLabel(cat: string): string {
  return CATEGORY_LABELS[cat] ?? cat;
}

function sortCurrencies(currencies: Iterable<string>): string[] {
  return [...new Set(currencies)].sort((a, b) => {
    if (a === 'eur') return -1;
    if (b === 'eur') return 1;
    return a.localeCompare(b);
  });
}

// ─── Table drawing ────────────────────────────────────────

interface Column {
  header: string;
  width: number; // fraction of the table width
  align?: 'left' | 'right';
}

const ROW_H = 16;
const HEADER_H = 18;
const LEFT = 40;

function fit(doc: PDFKit.PDFDocument, text: string, maxWidth: number): string {
  if (doc.widthOfString(text) <= maxWidth) return text;
  let t = text;
  while (t.length > 0 && doc.widthOfString(t + '…') > maxWidth) t = t.slice(0, -1);
  return t + '…';
}

function sectionTitle(doc: PDFKit.PDFDocument, title: string, subtitle: string | undefined, y: number): number {
  doc.rect(LEFT, y, 4, 18).fill(COLORS.accent);
  doc.fontSize(12).fillColor(COLORS.primary).font('Helvetica-Bold').text(title, 50, y + 2);
  doc.font('Helvetica');
  y += 20;
  if (subtitle) {
    doc.fontSize(7.5).fillColor(COLORS.textLight).text(subtitle, 50, y + 1);
    y += 14;
  }
  doc.fillColor(COLORS.text);
  return y + 8;
}

function drawTableHeader(doc: PDFKit.PDFDocument, columns: Column[], y: number, width: number): number {
  doc.rect(LEFT, y, width, HEADER_H).fill(COLORS.primary);
  doc.fontSize(7).fillColor(COLORS.white).font('Helvetica-Bold');
  let x = LEFT;
  for (const col of columns) {
    const w = width * col.width;
    doc.text(col.header, x + 3, y + 5, { width: w - 6, align: col.align ?? 'left', lineBreak: false });
    x += w;
  }
  doc.font('Helvetica').fillColor(COLORS.text);
  return y + HEADER_H;
}

function ensureSpace(doc: PDFKit.PDFDocument, y: number, needed: number): number {
  if (y + needed > doc.page.height - 50) {
    doc.addPage();
    return 40;
  }
  return y;
}

function drawTable(
  doc: PDFKit.PDFDocument,
  columns: Column[],
  rows: string[][],
  y: number,
  width: number,
  boldRows: boolean[] = [],
  fontSize = 7.5,
): number {
  y = ensureSpace(doc, y, HEADER_H + ROW_H);
  y = drawTableHeader(doc, columns, y, width);

  for (let i = 0; i < rows.length; i++) {
    if (y + ROW_H > doc.page.height - 50) {
      doc.addPage();
      y = drawTableHeader(doc, columns, 40, width);
    }
    const bold = boldRows[i] ?? false;
    const bg = bold ? COLORS.boldBg : (i % 2 === 0 ? COLORS.white : COLORS.lightBg);
    doc.rect(LEFT, y, width, ROW_H).fill(bg);
    doc.fontSize(fontSize).fillColor(bold ? COLORS.primary : COLORS.text).font(bold ? 'Helvetica-Bold' : 'Helvetica');

    let x = LEFT;
    for (let j = 0; j < columns.length; j++) {
      const w = width * columns[j].width;
      const text = fit(doc, rows[i][j] ?? '', w - 6);
      doc.text(text, x + 3, y + 4.5, { width: w - 6, align: columns[j].align ?? 'left', lineBreak: false });
      x += w;
    }
    y += ROW_H;
  }
  doc.font('Helvetica').fillColor(COLORS.text);
  return y + 4;
}

function note(doc: PDFKit.PDFDocument, text: string, y: number, width: number): number {
  doc.fontSize(7.5).fillColor(COLORS.textLight).text(text, LEFT, y, { width });
  const h = doc.heightOfString(text, { width });
  doc.fillColor(COLORS.text);
  return y + h + 6;
}

// ─── Main ─────────────────────────────────────────────────

export async function generateStripeStatementPdf(
  data: StripeStatementData,
  outputDir: string,
): Promise<string> {
  await mkdir(outputDir, { recursive: true });

  const mm = String(data.month).padStart(2, '0');
  const periodLabel = `${MONTH_NAMES_FR[data.month - 1]} ${data.year}`;
  const lastDay = new Date(Date.UTC(data.year, data.month, 0)).getUTCDate();
  const periodRange = `du 01/${mm}/${data.year} au ${lastDay}/${mm}/${data.year}`;

  const filename = `releve_stripe_${data.year}-${mm}.pdf`;
  const filepath = join(outputDir, filename);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: 40, bottom: 40, left: 40, right: 40 },
      bufferPages: true,
      info: {
        Title: `Relevé de compte Stripe - ${periodLabel}`,
        Author: 'BPA SOLUTIONS',
        Subject: 'Relevé mensuel du compte Stripe (solde, virements, transactions et frais)',
      },
    });

    const stream = createWriteStream(filepath);
    doc.pipe(stream);

    const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;

    // ─── HEADER ───────────────────────────────────────────
    doc.rect(0, 0, doc.page.width, 100).fill(COLORS.primary);
    doc.fontSize(20).fillColor(COLORS.white).text('RELEVÉ DE COMPTE STRIPE', LEFT, 22);
    doc.fontSize(13).fillColor('#8899bb').text(`${periodLabel} · ${periodRange}`, LEFT, 50);
    doc.fontSize(10).fillColor(COLORS.white).text(`BPA SOLUTIONS · Compte Stripe ${data.accountId}`, LEFT, 74);
    doc.fontSize(9).fillColor('#8899bb')
      .text(`Généré le ${fmtIsoDate(data.generatedAt)}`, 0, 50, { align: 'right', width: doc.page.width - LEFT })
      .text('Source : Stripe Financial Reports · fuseau Europe/Paris', 0, 64, { align: 'right', width: doc.page.width - LEFT });
    doc.fillColor(COLORS.text);

    let y = 118;
    y = note(doc,
      'Ce relevé regroupe les trois rapports financiers Stripe du mois : le rapport de solde (balance.summary.1), '
      + 'le rapport des virements vers le compte bancaire (payouts.itemized.3) et le rapport détaillé des transactions '
      + 'et frais (balance_change_from_activity.itemized.3). Les montants sont exprimés dans la devise du solde Stripe.',
      y, width);
    y += 6;

    // ─── 1. RAPPORT DE SOLDE ──────────────────────────────
    y = sectionTitle(doc, '1. Rapport de solde', 'Stripe « Balance summary » · solde d\'ouverture, activité, virements, solde de clôture', y);

    const balanceCurrencies = sortCurrencies(data.balance.map(r => r.currency));
    const amountW = 0.15;
    const balanceColumns: Column[] = [
      { header: 'Poste', width: 0.30 },
      { header: 'Libellé Stripe', width: 1 - 0.30 - amountW * balanceCurrencies.length },
      ...balanceCurrencies.map(c => ({ header: c.toUpperCase(), width: amountW, align: 'right' as const })),
    ];
    const balanceCats = [
      ...BALANCE_ORDER.filter(cat => data.balance.some(r => r.category === cat)),
      ...[...new Set(data.balance.map(r => r.category))].filter(cat => !BALANCE_ORDER.includes(cat)),
    ];
    const balanceRows: string[][] = [];
    const balanceBold: boolean[] = [];
    for (const cat of balanceCats) {
      const rs = data.balance.filter(r => r.category === cat);
      const desc = rs[0]?.description ?? '';
      const dateMatch = desc.match(/\((\d{4}-\d{2}-\d{2})\)/);
      const label = (BALANCE_LABELS[cat] ?? cat) + (dateMatch ? ` au ${fmtDate(dateMatch[1])}` : '');
      balanceRows.push([
        label,
        desc,
        ...balanceCurrencies.map(c => {
          const r = rs.find(x => x.currency === c);
          return r ? money(num(r.net_amount), c) : '';
        }),
      ]);
      balanceBold.push(cat === 'starting_balance' || cat === 'ending_balance');
    }
    if (balanceRows.length === 0) {
      y = note(doc, 'Aucune donnée de solde pour la période.', y, width);
    } else {
      y = drawTable(doc, balanceColumns, balanceRows, y, width, balanceBold);
    }
    if (balanceCurrencies.some(c => c !== 'eur')) {
      y = note(doc,
        'Les colonnes hors EUR correspondent aux soldes tenus par Stripe dans d\'autres devises '
        + '(par exemple les frais Stripe facturés en USD). Les paiements clients encaissés dans une autre devise '
        + 'sont convertis en EUR par Stripe.',
        y, width);
    }
    y += 10;

    // ─── 2. RAPPORT DES VIREMENTS ─────────────────────────
    y = ensureSpace(doc, y, 120);
    y = sectionTitle(doc, '2. Rapport des virements', 'Stripe « Payouts » · virements du solde Stripe vers le compte bancaire Qonto', y);

    const payouts = [...data.payouts].sort((a, b) => (a.effective_at ?? '').localeCompare(b.effective_at ?? ''));
    if (payouts.length === 0) {
      y = note(doc, 'Aucun virement sur la période.', y, width);
    } else {
      const payoutColumns: Column[] = [
        { header: 'Date', width: 0.15 },
        { header: 'ID virement', width: 0.28 },
        { header: 'Statut', width: 0.09 },
        { header: 'Arrivée prévue', width: 0.12 },
        { header: 'Brut', width: 0.12, align: 'right' },
        { header: 'Frais', width: 0.11, align: 'right' },
        { header: 'Net', width: 0.13, align: 'right' },
      ];
      const payoutRows: string[][] = payouts.map(p => {
        const cur = p.currency || 'eur';
        const cat = p.reporting_category && p.reporting_category !== 'payout' ? ` (${categoryLabel(p.reporting_category)})` : '';
        return [
          fmtDateTime(p.effective_at),
          `${p.payout_id ?? ''}${cat}`,
          PAYOUT_STATUS[p.payout_status ?? ''] ?? (p.payout_status ?? ''),
          fmtDate(p.payout_expected_arrival_date),
          money(num(p.gross), cur),
          money(num(p.fee), cur),
          money(num(p.net), cur),
        ];
      });
      const payoutBold: boolean[] = payouts.map(() => false);
      for (const cur of sortCurrencies(payouts.map(p => p.currency || 'eur'))) {
        const ps = payouts.filter(p => (p.currency || 'eur') === cur);
        payoutRows.push([
          `Total ${cur.toUpperCase()}`, `${ps.length} virement${ps.length > 1 ? 's' : ''}`, '', '',
          money(ps.reduce((s, p) => s + num(p.gross), 0), cur),
          money(ps.reduce((s, p) => s + num(p.fee), 0), cur),
          money(ps.reduce((s, p) => s + num(p.net), 0), cur),
        ]);
        payoutBold.push(true);
      }
      y = drawTable(doc, payoutColumns, payoutRows, y, width, payoutBold);
    }
    y += 10;

    // ─── 3. RAPPORT DES TRANSACTIONS ET FRAIS ─────────────
    y = ensureSpace(doc, y, 160);
    y = sectionTitle(doc, '3. Rapport des transactions et frais', 'Stripe « Balance change from activity » · chaque mouvement du solde Stripe hors virements (paiements, remboursements, litiges, frais)', y);

    const activity = [...data.activity].sort((a, b) => (a.created ?? '').localeCompare(b.created ?? ''));
    if (activity.length === 0) {
      y = note(doc, 'Aucun mouvement sur la période.', y, width);
    } else {
      // 3a. Summary by category and currency
      const summaryColumns: Column[] = [
        { header: 'Catégorie', width: 0.34 },
        { header: 'Nb', width: 0.10, align: 'right' },
        { header: 'Brut', width: 0.19, align: 'right' },
        { header: 'Frais', width: 0.18, align: 'right' },
        { header: 'Net', width: 0.19, align: 'right' },
      ];
      const activityCurrencies = sortCurrencies(activity.map(a => a.currency || 'eur'));
      const summaryRows: string[][] = [];
      const summaryBold: boolean[] = [];
      for (const cur of activityCurrencies) {
        const inCur = activity.filter(a => (a.currency || 'eur') === cur);
        const cats = [...new Set(inCur.map(a => a.reporting_category))].sort((a, b) => {
          const ia = CATEGORY_ORDER.indexOf(a); const ib = CATEGORY_ORDER.indexOf(b);
          return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib) || a.localeCompare(b);
        });
        for (const cat of cats) {
          const rs = inCur.filter(a => a.reporting_category === cat);
          summaryRows.push([
            activityCurrencies.length > 1 ? `${categoryLabel(cat)} (${cur.toUpperCase()})` : categoryLabel(cat),
            String(rs.length),
            money(rs.reduce((s, a) => s + num(a.gross), 0), cur),
            money(rs.reduce((s, a) => s + num(a.fee), 0), cur),
            money(rs.reduce((s, a) => s + num(a.net), 0), cur),
          ]);
          summaryBold.push(false);
        }
        summaryRows.push([
          `Total ${cur.toUpperCase()}`,
          String(inCur.length),
          money(inCur.reduce((s, a) => s + num(a.gross), 0), cur),
          money(inCur.reduce((s, a) => s + num(a.fee), 0), cur),
          money(inCur.reduce((s, a) => s + num(a.net), 0), cur),
        ]);
        summaryBold.push(true);
      }
      y = drawTable(doc, summaryColumns, summaryRows, y, width, summaryBold);
      y += 8;

      // 3b. Detail
      doc.fontSize(9).fillColor(COLORS.primary).font('Helvetica-Bold')
        .text(`Détail des ${activity.length} mouvement${activity.length > 1 ? 's' : ''}`, 50, y);
      doc.font('Helvetica').fillColor(COLORS.text);
      y += 16;

      const detailColumns: Column[] = [
        { header: 'Date', width: 0.14 },
        { header: 'ID transaction', width: 0.24 },
        { header: 'Catégorie', width: 0.12 },
        { header: 'Description', width: 0.22 },
        { header: 'Brut', width: 0.10, align: 'right' },
        { header: 'Frais', width: 0.08, align: 'right' },
        { header: 'Net', width: 0.10, align: 'right' },
      ];
      const detailRows: string[][] = activity.map(a => {
        const cur = a.currency || 'eur';
        return [
          fmtDateTime(a.created),
          a.balance_transaction_id ?? '',
          categoryLabel(a.reporting_category ?? ''),
          a.description ?? '',
          money(num(a.gross), cur),
          money(num(a.fee), cur),
          money(num(a.net), cur),
        ];
      });
      y = drawTable(doc, detailColumns, detailRows, y, width, [], 7);
    }

    // ─── FOOTER ───────────────────────────────────────────
    const range = doc.bufferedPageRange();
    for (let p = range.start; p < range.start + range.count; p++) {
      doc.switchToPage(p);
      doc.fontSize(7).fillColor(COLORS.textLight);
      doc.text(
        `BPA SOLUTIONS — Relevé de compte Stripe ${periodLabel} — Page ${p - range.start + 1}/${range.count}`,
        LEFT,
        doc.page.height - 30,
        { width, align: 'center', lineBreak: false },
      );
    }

    doc.end();
    stream.on('finish', () => resolve(filepath));
    stream.on('error', reject);
  });
}
