import PDFDocument from 'pdfkit';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { MonthlyReport, CategorizedTransaction } from '../types.js';
import type { PayoutDetail, PayoutFee } from '../stripe/payouts.js';
import { MONTH_NAMES_FR, getCountryName } from '../config.js';

const COLORS = {
  primary: '#1a2b4a',
  accent: '#2980b9',
  lightBg: '#f4f7fa',
  border: '#dce4ec',
  text: '#333333',
  textLight: '#666666',
  green: '#27ae60',
  red: '#e74c3c',
  white: '#ffffff',
};

function eur(cents: number): string {
  return (cents / 100).toFixed(2).replace('.', ',') + ' €';
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;
}

export async function generateMonthlyPdf(
  report: MonthlyReport,
  outputDir: string,
  payouts?: PayoutDetail[],
  standaloneFees?: PayoutFee[],
): Promise<string> {
  await mkdir(outputDir, { recursive: true });

  const filename = `justificatif_${report.period.year}-${String(report.period.month).padStart(2, '0')}.pdf`;
  const filepath = join(outputDir, filename);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: 40, bottom: 40, left: 40, right: 40 },
      info: {
        Title: `Justificatif Stripe - ${report.period.label}`,
        Author: 'BPA SOLUTIONS',
        Subject: 'Justificatif comptable mensuel',
      },
    });

    const stream = createWriteStream(filepath);
    doc.pipe(stream);

    const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const sales = report.transactions.filter(t => t.type === 'sale');
    const refunds = report.transactions.filter(t => t.type === 'refund');

    // ─── HEADER ───────────────────────────────────────────
    doc.rect(0, 0, doc.page.width, 100).fill(COLORS.primary);

    doc.fontSize(22).fillColor(COLORS.white)
      .text('JUSTIFICATIF STRIPE', 40, 25, { align: 'left' });

    doc.fontSize(14).fillColor('#8899bb')
      .text(`${report.period.label}`, 40, 55, { align: 'left' });

    doc.fontSize(10).fillColor(COLORS.white)
      .text('BPA SOLUTIONS', 40, 75, { align: 'left' });

    doc.fontSize(10).fillColor('#8899bb')
      .text(`Généré le ${fmtDate(report.generatedAt)}`, 0, 55, {
        align: 'right',
        width: doc.page.width - 40,
      });

    doc.fillColor(COLORS.text);
    let y = 120;

    // ─── RÉSUMÉ ───────────────────────────────────────────
    y = sectionTitle(doc, 'Résumé du mois', y, pageWidth);

    const s = report.summary;
    const disputes = report.transactions.filter(t => t.type === 'dispute');
    const summaryRows = [
      ['Ventes TTC', eur(s.totalSalesTTC), `${sales.length} transaction(s)`],
      ['Ventes HT', eur(s.totalSalesHT), ''],
      ['TVA collectée', eur(s.totalTVA), ''],
    ];
    if (refunds.length > 0) {
      const refundTotal = refunds.reduce((acc, t) => acc + t.amountTTC, 0);
      summaryRows.push(['Remboursements', eur(refundTotal), `${refunds.length} remboursement(s)`]);
    }
    if (disputes.length > 0) {
      const disputeTotal = disputes.reduce((acc, t) => acc + t.amountTTC, 0);
      const disputeFees = disputes.reduce((acc, t) => acc + t.stripeFee, 0);
      summaryRows.push(['Litiges (chargebacks)', eur(disputeTotal), `${disputes.length} litige(s) + ${eur(disputeFees)} frais`]);
    }
    summaryRows.push(
      ['Commissions Stripe', eur(s.fees.totalFees), `${((s.fees.totalFees / (s.totalSalesTTC || 1)) * 100).toFixed(2)}%`],
      ['Revenu net', eur(s.netRevenue), ''],
    );

    y = drawSummaryTable(doc, summaryRows, y, pageWidth);
    y += 15;

    // ─── PAR ZONE ─────────────────────────────────────────
    y = sectionTitle(doc, 'Ventilation par zone géographique', y, pageWidth);

    const zoneRows: string[][] = [];
    const zoneBold: boolean[] = [];
    for (const [, zone] of Object.entries(report.byZone)) {
      // Total row for zone (BOLD)
      zoneRows.push([zone.label, String(zone.count), eur(zone.totalHT), eur(zone.totalTVA), eur(zone.totalTTC)]);
      zoneBold.push(true);
      // Sub-row: B2B (avec n° TVA)
      if (zone.b2b.count > 0) {
        zoneRows.push([
          `   └ Pro (n° TVA fourni)`,
          String(zone.b2b.count),
          eur(zone.b2b.totalHT),
          eur(zone.b2b.totalTVA),
          eur(zone.b2b.totalTTC),
        ]);
        zoneBold.push(false);
      }
      // Sub-row: B2C (particuliers)
      if (zone.b2c.count > 0) {
        zoneRows.push([
          `   └ Particuliers`,
          String(zone.b2c.count),
          eur(zone.b2c.totalHT),
          eur(zone.b2c.totalTVA),
          eur(zone.b2c.totalTTC),
        ]);
        zoneBold.push(false);
      }
    }
    y = drawTable(doc, ['Zone / Type client', 'Nb', 'HT', 'TVA', 'TTC'], zoneRows, y, pageWidth, [0.35, 0.1, 0.18, 0.18, 0.19], zoneBold);
    y += 15;

    // ─── PAR TAUX TVA ─────────────────────────────────────
    if (y > 650) { doc.addPage(); y = 40; }
    y = sectionTitle(doc, 'Ventilation par taux de TVA', y, pageWidth);

    const vatRows: string[][] = [];
    const vatBold: boolean[] = [];
    // Sort: taxed rates first (desc), then exonéré (0) last
    const vatEntries = Object.entries(report.byVatRate).sort(([, a], [, b]) => b.rate - a.rate);
    for (const [, vat] of vatEntries) {
      vatRows.push([vat.label, String(vat.count), eur(vat.totalHT), eur(vat.totalTVA), eur(vat.totalTTC)]);
      vatBold.push(true);

      if (vat.rate === 0 && vat.exemptByReason) {
        // Detail: reverse charge (UE B2B) vs export (Hors UE)
        if (vat.exemptByReason.reverseCharge.count > 0) {
          vatRows.push([
            `   └ Autoliquidation UE (B2B n° TVA)`,
            String(vat.exemptByReason.reverseCharge.count),
            eur(vat.exemptByReason.reverseCharge.totalHT),
            eur(vat.exemptByReason.reverseCharge.totalTVA),
            eur(vat.exemptByReason.reverseCharge.totalTTC),
          ]);
          vatBold.push(false);
        }
        if (vat.exemptByReason.export.count > 0) {
          vatRows.push([
            `   └ Export Hors UE`,
            String(vat.exemptByReason.export.count),
            eur(vat.exemptByReason.export.totalHT),
            eur(vat.exemptByReason.export.totalTVA),
            eur(vat.exemptByReason.export.totalTTC),
          ]);
          vatBold.push(false);
        }
        // Plus B2B/particulier au sein de l'exonéré
        if (vat.b2b.count > 0) {
          vatRows.push([
            `       dont Pro (n° TVA)`,
            String(vat.b2b.count),
            eur(vat.b2b.totalHT),
            eur(vat.b2b.totalTVA),
            eur(vat.b2b.totalTTC),
          ]);
          vatBold.push(false);
        }
        if (vat.b2c.count > 0) {
          vatRows.push([
            `       dont Particuliers`,
            String(vat.b2c.count),
            eur(vat.b2c.totalHT),
            eur(vat.b2c.totalTVA),
            eur(vat.b2c.totalTTC),
          ]);
          vatBold.push(false);
        }
      } else {
        // Taxed rates: show B2B/B2C breakdown
        if (vat.b2b.count > 0) {
          vatRows.push([
            `   └ Pro (n° TVA)`,
            String(vat.b2b.count),
            eur(vat.b2b.totalHT),
            eur(vat.b2b.totalTVA),
            eur(vat.b2b.totalTTC),
          ]);
          vatBold.push(false);
        }
        if (vat.b2c.count > 0) {
          vatRows.push([
            `   └ Particuliers`,
            String(vat.b2c.count),
            eur(vat.b2c.totalHT),
            eur(vat.b2c.totalTVA),
            eur(vat.b2c.totalTTC),
          ]);
          vatBold.push(false);
        }
      }
    }
    y = drawTable(doc, ['Taux / Motif', 'Nb', 'HT', 'TVA', 'TTC'], vatRows, y, pageWidth, [0.35, 0.1, 0.18, 0.18, 0.19], vatBold);
    y += 15;

    // ─── DÉTAIL OSS (ventes particuliers UE) ──────────────
    if (report.oss.totalCount > 0) {
      if (y > 620) { doc.addPage(); y = 40; }
      y = sectionTitle(doc, 'Detail OSS - Ventes a particuliers UE', y, pageWidth);

      // Explanation text
      doc.fontSize(7).fillColor(COLORS.textLight).font('Helvetica-Oblique');
      doc.text(
        `Guichet unique (OSS) : ventes de services a des particuliers dans l'UE (hors France). ` +
        `Sous le seuil annuel de 10 000 EUR cross-border, la TVA francaise s'applique. ` +
        `Au-dela, la TVA du pays de destination doit etre facturee et declaree via OSS.`,
        50, y, { width: pageWidth - 20 },
      );
      doc.font('Helvetica').fillColor(COLORS.text);
      y += 22;

      const ossRows: string[][] = [];
      const ossBold: boolean[] = [];
      const sortedOss = Object.entries(report.oss.byCountry).sort(([, a], [, b]) => b.totalTTC - a.totalTTC);
      for (const [code, d] of sortedOss) {
        const rateLabel = d.vatRate === 0 ? 'Exonere' : `${(d.vatRate * 100).toFixed(1)}% (FR)`;
        ossRows.push([
          `${getCountryName(code)} (${code})`,
          String(d.count),
          rateLabel,
          eur(d.totalHT),
          eur(d.totalTVA),
          eur(d.totalTTC),
        ]);
        ossBold.push(false);
      }
      // Total row (bold)
      ossRows.push([
        'TOTAL OSS',
        String(report.oss.totalCount),
        '',
        eur(report.oss.totalHT),
        eur(report.oss.totalTVA),
        eur(report.oss.totalTTC),
      ]);
      ossBold.push(true);
      y = drawTable(doc, ['Pays', 'Nb', 'Taux TVA', 'HT', 'TVA', 'TTC'], ossRows, y, pageWidth, [0.29, 0.08, 0.15, 0.16, 0.16, 0.16], ossBold);
      y += 15;
    }

    // ─── PAR PAYS ─────────────────────────────────────────
    if (y > 650) { doc.addPage(); y = 40; }
    y = sectionTitle(doc, 'Ventilation par pays', y, pageWidth);

    const countryRows: string[][] = [];
    const sortedCountries = Object.entries(report.byCountry).sort(([, a], [, b]) => b.totalTTC - a.totalTTC);
    for (const [code, data] of sortedCountries) {
      countryRows.push([`${getCountryName(code)} (${code})`, String(data.count), eur(data.totalHT), eur(data.totalTVA), eur(data.totalTTC)]);
    }
    y = drawTable(doc, ['Pays', 'Nb', 'HT', 'TVA', 'TTC'], countryRows, y, pageWidth, [0.35, 0.1, 0.18, 0.18, 0.19]);

    // ─── REMBOURSEMENTS & LITIGES (ventilés séparément des ventes) ───
    const refundsDisputes = [...refunds, ...disputes];
    if (refundsDisputes.length > 0) {
      if (y > 540) { doc.addPage(); y = 40; } else { y += 15; }
      y = sectionTitle(doc, 'Remboursements & litiges', y, pageWidth);

      doc.fontSize(7).fillColor(COLORS.textLight).font('Helvetica-Oblique');
      doc.text(
        `Comptabilises separement des ventes (compte 709000). Les ventilations ci-dessus sont en VENTES BRUTES ; ` +
        `le chiffre d'affaires net = ventes brutes moins ces montants.`,
        50, y, { width: pageWidth - 20 });
      doc.font('Helvetica').fillColor(COLORS.text);
      y += 18;

      const rdRows: string[][] = [];
      const rdBold: boolean[] = [];
      for (const t of refundsDisputes) {
        const typeL = t.type === 'dispute' ? 'Litige' : 'Rembours.';
        const vatL = t.vatRate === 0 ? 'Exonere' : `${(t.vatRate * 100).toFixed(0)}%`;
        rdRows.push([
          fmtDate(t.date),
          typeL,
          (t.stripeCustomerName ?? t.stripeCustomerEmail ?? '').substring(0, 22),
          `${t.country} / ${vatL}`,
          eur(t.amountHT),
          eur(t.amountTVA),
          eur(t.amountTTC),
        ]);
        rdBold.push(false);
      }
      const rdHT = refundsDisputes.reduce((a, t) => a + t.amountHT, 0);
      const rdTVA = refundsDisputes.reduce((a, t) => a + t.amountTVA, 0);
      const rdTTC = refundsDisputes.reduce((a, t) => a + t.amountTTC, 0);
      rdRows.push(['TOTAL', `${refundsDisputes.length} op.`, '', '', eur(rdHT), eur(rdTVA), eur(rdTTC)]);
      rdBold.push(true);

      y = drawTable(doc,
        ['Date', 'Type', 'Client', 'Pays / TVA', 'HT', 'TVA', 'TTC'],
        rdRows, y, pageWidth, [0.12, 0.11, 0.25, 0.16, 0.12, 0.12, 0.12], rdBold);
      y += 12;

      // ── Encadré de réconciliation : ventes brutes − remboursements = CA net ──
      const reconH = 58;
      if (y > 690) { doc.addPage(); y = 40; }
      doc.rect(40, y, pageWidth, reconH).fill(COLORS.lightBg);
      doc.rect(40, y, 4, reconH).fill(COLORS.accent);
      const rvLabelX = 55;
      const rvValW = pageWidth * 0.3;
      const rvValX = 40 + pageWidth * 0.68;
      let ry = y + 8;
      doc.fontSize(9).fillColor(COLORS.text).font('Helvetica');
      doc.text('Ventes brutes (somme des ventilations ci-dessus)', rvLabelX, ry);
      doc.text(eur(s.totalSalesTTC), rvValX, ry, { width: rvValW, align: 'right' });
      ry += 16;
      doc.fillColor(COLORS.red);
      doc.text('Remboursements & litiges', rvLabelX, ry);
      doc.text(eur(rdTTC), rvValX, ry, { width: rvValW, align: 'right' });
      ry += 16;
      doc.fillColor(COLORS.primary).font('Helvetica-Bold');
      doc.text("= Chiffre d'affaires net", rvLabelX, ry);
      doc.text(eur(s.totalSalesTTC + rdTTC), rvValX, ry, { width: rvValW, align: 'right' });
      doc.font('Helvetica').fillColor(COLORS.text);
      y += reconH + 8;
    }

    // ─── DÉTAIL DES TRANSACTIONS ──────────────────────────
    doc.addPage();
    y = 40;
    y = sectionTitle(doc, 'Detail des transactions', y, pageWidth);

    // Build chargeId → payout arrival date mapping
    const chargeToPayoutDate = new Map<string, string>();
    if (payouts) {
      for (const po of payouts) {
        const arrivalDate = fmtDate(po.date);
        for (const c of po.charges) {
          chargeToPayoutDate.set(c.chargeId, arrivalDate);
        }
        for (const r of po.refunds) {
          chargeToPayoutDate.set(r.refundId, arrivalDate);
        }
      }
    }

    const txnHeaders = ['Date', 'Verse le', 'ID Stripe', 'Client', 'Pays', 'TTC', 'TVA', 'Fees'];
    const txnWidths = [0.08, 0.08, 0.14, 0.2, 0.06, 0.11, 0.11, 0.11, 0.11];

    // Header row
    y = drawTableHeader(doc, txnHeaders, y, pageWidth, txnWidths);

    for (let i = 0; i < report.transactions.length; i++) {
      const t = report.transactions[i];

      if (y > 750) {
        doc.addPage();
        y = 40;
        y = drawTableHeader(doc, txnHeaders, y, pageWidth, txnWidths);
      }

      const isDebit = t.type === 'refund' || t.type === 'dispute';
      const bgColor = i % 2 === 0 ? COLORS.white : COLORS.lightBg;

      doc.rect(40, y, pageWidth, 28).fill(bgColor);

      doc.fontSize(6.5).fillColor(isDebit ? COLORS.red : COLORS.text);

      const payoutDate = chargeToPayoutDate.get(t.stripeChargeId) ?? '-';

      // Prefix for refunds/disputes
      const typePrefix = t.type === 'dispute' ? '[LITIGE] ' : t.type === 'refund' ? '[REMBOURS.] ' : '';

      const cols = [
        fmtDate(t.date),
        payoutDate,
        t.stripeChargeId.replace('ch_', '').replace('py_', '').replace('du_', '').substring(0, 16),
        `${typePrefix}${(t.stripeCustomerName ?? t.stripeCustomerEmail ?? '').substring(0, 18)}`,
        t.country,
        eur(t.amountTTC),
        eur(t.amountTVA),
        eur(t.stripeFee),
      ];

      let x = 40;
      for (let j = 0; j < cols.length; j++) {
        doc.text(cols[j], x + 2, y + 4, {
          width: pageWidth * txnWidths[j] - 4,
          height: 24,
          ellipsis: true,
        });
        x += pageWidth * txnWidths[j];
      }

      // Second line: full charge ID + invoice + currency info + zone/VAT for refunds/disputes
      doc.fontSize(5.5).fillColor(COLORS.textLight);
      const invoiceStr = t.stripeInvoiceId ? ` | Facture: ${t.stripeInvoiceId}` : '';
      const zoneLabel = t.zone === 'france' ? 'France' : t.zone === 'ue' ? 'UE' : 'Hors UE';
      const vatLabel = t.vatRate === 0
        ? (t.vatExemptReason === 'reverse_charge' ? 'Autoliquidation UE' : t.vatExemptReason === 'export' ? 'Export exonere' : 'Exonere')
        : `TVA ${(t.vatRate * 100).toFixed(0)}%`;
      const categoryStr = isDebit ? ` | ${zoneLabel} - ${vatLabel} - ${t.isB2B ? 'Pro' : 'Particulier'}` : '';
      const subLine = `${t.stripeChargeId} | ${t.originalCurrency} ${(Math.abs(t.originalAmount) / 100).toFixed(2)}${t.exchangeRate ? ` @ ${t.exchangeRate.toFixed(4)}` : ''} | Net: ${eur(t.netAmount)}${invoiceStr}${categoryStr}`;
      doc.text(subLine, 42, y + 15, { width: pageWidth - 4 });

      y += 28;
    }

    // ─── TOTAUX ───────────────────────────────────────────
    y += 5;
    doc.rect(40, y, pageWidth, 1).fill(COLORS.primary);
    y += 8;

    doc.fontSize(9).fillColor(COLORS.primary).font('Helvetica-Bold');
    doc.text(`Total: ${sales.length} vente(s)`, 42, y);
    doc.text(`TTC: ${eur(s.totalSalesTTC)}`, 42 + pageWidth * 0.4, y);
    doc.text(`TVA: ${eur(s.totalTVA)}`, 42 + pageWidth * 0.55, y);
    doc.text(`Fees: ${eur(s.fees.totalFees)}`, 42 + pageWidth * 0.7, y);
    doc.font('Helvetica');

    if (refunds.length > 0 || disputes.length > 0) {
      y += 15;
      doc.fontSize(9).fillColor(COLORS.red).font('Helvetica-Bold');
      if (refunds.length > 0) {
        const refundTotal = refunds.reduce((acc, t) => acc + t.amountTTC, 0);
        doc.text(`Remboursements: ${refunds.length}`, 42, y);
        doc.text(`TTC: ${eur(refundTotal)}`, 42 + pageWidth * 0.4, y);
        y += 15;
      }
      if (disputes.length > 0) {
        const disputeTotal = disputes.reduce((acc, t) => acc + t.amountTTC, 0);
        const disputeFees = disputes.reduce((acc, t) => acc + t.stripeFee, 0);
        doc.text(`Litiges: ${disputes.length}`, 42, y);
        doc.text(`TTC: ${eur(disputeTotal)} (+ ${eur(disputeFees)} frais litige)`, 42 + pageWidth * 0.4, y);
      }
      doc.font('Helvetica');
    }

    // ─── RÉCONCILIATION PAYOUTS ──────────────────────────
    if (payouts && payouts.length > 0) {
      doc.addPage();
      y = 40;

      // Month boundaries for annotation
      const reportMonthStart = new Date(Date.UTC(report.period.year, report.period.month - 1, 1));
      const reportMonthEnd = new Date(Date.UTC(report.period.year, report.period.month, 1));

      // Compute next month name for labels
      const nextMonthIdx = report.period.month % 12; // 0-indexed for next month
      const nextMonthYear = report.period.month === 12 ? report.period.year + 1 : report.period.year;
      const nextMonthLabel = `${MONTH_NAMES_FR[nextMonthIdx]} ${nextMonthYear}`;

      // Section header with blue background
      doc.rect(0, 0, doc.page.width, 60).fill(COLORS.primary);
      doc.fontSize(18).fillColor(COLORS.white)
        .text('RECONCILIATION PAYOUTS -- RELEVE BANCAIRE', 40, 15);
      doc.fontSize(10).fillColor('#8899bb')
        .text(`${report.period.label} -- ${payouts.length} virement(s) vers le compte bancaire Qonto`, 40, 40);
      doc.fillColor(COLORS.text);
      y = 75;

      for (let pi = 0; pi < payouts.length; pi++) {
        const po = payouts[pi];
        const payoutArrivalDate = fmtDate(po.date);

        // Detect if this payout arrived in a different month than the report
        const payoutDate = new Date(po.date);
        const isNextMonthPayout = payoutDate >= reportMonthEnd;

        // Check if we need a new page
        if (y > 600) {
          doc.addPage();
          y = 40;
        }

        // Payout header box - different color for next-month payouts
        const headerColor = isNextMonthPayout ? '#2c3e50' : COLORS.primary;
        doc.rect(40, y, pageWidth, isNextMonthPayout ? 68 : 55).fill(headerColor);

        if (isNextMonthPayout) {
          // Clear label: "VERSE EN [next month] — contient des charges de [current month]"
          doc.fontSize(7).fillColor('#e67e22').font('Helvetica-Bold');
          doc.text(`VERSE EN ${nextMonthLabel.toUpperCase()} -- contient des charges de ${report.period.label}`, 50, y + 4);
          doc.font('Helvetica');
          const yOff = 12;

          doc.fontSize(11).fillColor(COLORS.white).font('Helvetica-Bold');
          doc.text(`Payout #${pi + 1}`, 50, y + 5 + yOff);
          doc.fontSize(14).fillColor(COLORS.white).font('Helvetica-Bold');
          doc.text(eur(po.amount), 0, y + 4 + yOff, { width: doc.page.width - 50, align: 'right' });

          doc.fontSize(8).fillColor('#aabbdd').font('Helvetica');
          doc.text(`ID: ${po.payoutId}`, 50, y + 22 + yOff);
          doc.text(`Arrive sur Qonto: ${payoutArrivalDate}`, 0, y + 22 + yOff, { width: doc.page.width - 50, align: 'right' });
          doc.text(`Statut: ${po.status}`, 50, y + 36 + yOff);

          doc.fillColor(COLORS.text).font('Helvetica');
          y += 73;
        } else {
          doc.fontSize(11).fillColor(COLORS.white).font('Helvetica-Bold');
          doc.text(`Payout #${pi + 1}`, 50, y + 5);
          doc.fontSize(14).fillColor(COLORS.white).font('Helvetica-Bold');
          doc.text(eur(po.amount), 0, y + 4, { width: doc.page.width - 50, align: 'right' });

          doc.fontSize(8).fillColor('#aabbdd').font('Helvetica');
          doc.text(`ID: ${po.payoutId}`, 50, y + 22);
          doc.text(`Arrive sur Qonto: ${payoutArrivalDate}`, 0, y + 22, { width: doc.page.width - 50, align: 'right' });
          doc.text(`Statut: ${po.status}`, 50, y + 36);

          doc.fillColor(COLORS.text).font('Helvetica');
          y += 60;
        }

        // ── Payout summary box ──
        const hasOther = po.totalOther !== 0;
        const nCharges = po.charges.length;
        const nRefunds = po.refunds.length;
        const nBillingFees = po.stripeBillingFees.length;
        const totalProcessingFees = po.totalFees; // fees on charges
        const summaryHeight = hasOther ? 46 : 34;
        doc.rect(40, y, pageWidth, summaryHeight).fill(COLORS.lightBg);
        doc.fontSize(7.5).fillColor(COLORS.text);

        // Row 1: Charges + Refunds counts and totals
        doc.font('Helvetica-Bold');
        doc.text(`${nCharges} charge(s): ${eur(po.totalCharges)}`, 50, y + 5);
        doc.text(`${nRefunds} remboursement(s): ${eur(po.totalRefunds)}`, 50 + pageWidth * 0.3, y + 5);
        doc.font('Helvetica');

        // Row 2: Processing fees + Billing fees + totals
        doc.text(`Frais sur transactions: ${eur(totalProcessingFees)}`, 50, y + 17);
        doc.text(`Frais Stripe (billing): ${eur(po.totalBillingFees)}  (${nBillingFees} ligne(s))`, 50 + pageWidth * 0.3, y + 17);
        doc.font('Helvetica-Bold').fillColor(COLORS.accent);
        doc.text(`Total frais: ${eur(totalProcessingFees + Math.abs(po.totalBillingFees))}`, 50 + pageWidth * 0.65, y + 17);
        doc.font('Helvetica').fillColor(COLORS.text);

        if (hasOther) {
          doc.text(`Autres mouvements (reserves Stripe): ${eur(po.totalOther)}`, 50, y + 29);
        }

        // Verification
        const computed = po.totalCharges - po.totalFees + po.totalRefunds + po.totalBillingFees + po.totalOther;
        const diff = po.amount - computed;
        const checkColor = Math.abs(diff) <= 1 ? COLORS.green : COLORS.red;
        doc.fillColor(checkColor).font('Helvetica-Bold');
        doc.text(Math.abs(diff) <= 1 ? 'OK - Reconcilie' : `Ecart: ${eur(diff)}`, 50 + pageWidth * 0.82, y + 5);
        doc.font('Helvetica').fillColor(COLORS.text);
        y += summaryHeight + 3;

        // ── Charges table — split by current month vs other month ──
        if (po.charges.length > 0) {
          if (y > 700) { doc.addPage(); y = 40; }

          const chgHeaders = ['Date', 'Charge ID', 'Brut', 'Fees', 'Net', 'Description'];
          const chgWidths = [0.1, 0.2, 0.12, 0.12, 0.12, 0.34];

          // Split charges into current month and other month
          const currentMonthCharges = po.charges.filter(c => {
            const d = new Date(c.date);
            return d >= reportMonthStart && d < reportMonthEnd;
          });
          const otherMonthCharges = po.charges.filter(c => {
            const d = new Date(c.date);
            return d < reportMonthStart || d >= reportMonthEnd;
          });

          // Helper to render a group of charges with a sub-header and subtotal
          const renderChargeGroup = (
            charges: typeof po.charges,
            label: string,
            labelColor: string,
            rowColor: string,
            textColor: string,
            subtotalColor: string,
          ) => {
            if (charges.length === 0) return;
            if (y > 700) { doc.addPage(); y = 40; }

            doc.fontSize(8).fillColor(labelColor).font('Helvetica-Bold');
            doc.text(label, 50, y + 2);
            doc.font('Helvetica').fillColor(COLORS.text);
            y += 14;

            y = drawTableHeader(doc, chgHeaders, y, pageWidth, chgWidths);

            let subBrut = 0, subFees = 0, subNet = 0;
            for (let ci = 0; ci < charges.length; ci++) {
              if (y > 750) {
                doc.addPage();
                y = 40;
                y = drawTableHeader(doc, chgHeaders, y, pageWidth, chgWidths);
              }
              const c = charges[ci];
              subBrut += c.grossAmount;
              subFees += c.fee;
              subNet += c.net;

              const bg = ci % 2 === 0 ? COLORS.white : rowColor;
              doc.rect(40, y, pageWidth, 16).fill(bg);
              doc.fontSize(6.5).fillColor(textColor);

              const chgCols = [
                fmtDate(c.date), c.chargeId, eur(c.grossAmount),
                eur(c.fee), eur(c.net), c.description.substring(0, 45),
              ];
              let x = 40;
              for (let j = 0; j < chgCols.length; j++) {
                doc.text(chgCols[j], x + 2, y + 4, {
                  width: pageWidth * chgWidths[j] - 4, height: 14, ellipsis: true,
                });
                x += pageWidth * chgWidths[j];
              }
              y += 16;
            }

            // Subtotal row
            doc.rect(40, y, pageWidth, 16).fill(subtotalColor);
            doc.fontSize(6.5).fillColor(COLORS.white).font('Helvetica-Bold');
            let x = 40;
            doc.text(`Sous-total: ${charges.length} charge(s)`, x + 2, y + 4, {
              width: pageWidth * (chgWidths[0] + chgWidths[1]) - 4,
            });
            x += pageWidth * (chgWidths[0] + chgWidths[1]);
            doc.text(eur(subBrut), x + 2, y + 4, { width: pageWidth * chgWidths[2] - 4 });
            x += pageWidth * chgWidths[2];
            doc.text(eur(subFees), x + 2, y + 4, { width: pageWidth * chgWidths[3] - 4 });
            x += pageWidth * chgWidths[3];
            doc.text(eur(subNet), x + 2, y + 4, { width: pageWidth * chgWidths[4] - 4 });
            doc.font('Helvetica').fillColor(COLORS.text);
            y += 21;
          };

          // Current month charges first
          renderChargeGroup(
            currentMonthCharges,
            `Charges ${report.period.label} (${currentMonthCharges.length})`,
            COLORS.accent, COLORS.lightBg, COLORS.text, COLORS.accent,
          );

          // Other month charges
          if (otherMonthCharges.length > 0) {
            // Determine which month(s) these belong to
            const otherMonths = new Set(otherMonthCharges.map(c => {
              const d = new Date(c.date);
              return `${MONTH_NAMES_FR[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
            }));
            const otherLabel = [...otherMonths].join(', ');

            renderChargeGroup(
              otherMonthCharges,
              `Charges ${otherLabel} (${otherMonthCharges.length}) -- autre mois`,
              '#e65100', '#fff3e0', '#e65100', '#e65100',
            );
          }
        }

        // ── Refunds table ──
        if (po.refunds.length > 0) {
          if (y > 700) { doc.addPage(); y = 40; }

          doc.fontSize(8).fillColor(COLORS.red).font('Helvetica-Bold');
          doc.text(`Remboursements (${po.refunds.length})`, 50, y + 2);
          doc.font('Helvetica').fillColor(COLORS.text);
          y += 14;

          const refHeaders = ['Date', 'Refund ID', 'Montant', 'Fees', 'Net', 'Description'];
          const refWidths = [0.1, 0.2, 0.12, 0.12, 0.12, 0.34];
          y = drawTableHeader(doc, refHeaders, y, pageWidth, refWidths);

          for (let ri = 0; ri < po.refunds.length; ri++) {
            if (y > 750) {
              doc.addPage();
              y = 40;
              y = drawTableHeader(doc, refHeaders, y, pageWidth, refWidths);
            }
            const r = po.refunds[ri];
            const refundDate = new Date(r.date);
            const isOtherMonthRef = refundDate < reportMonthStart || refundDate >= reportMonthEnd;
            const bg = isOtherMonthRef ? '#fff3e0' : (ri % 2 === 0 ? COLORS.white : COLORS.lightBg);
            doc.rect(40, y, pageWidth, 16).fill(bg);
            doc.fontSize(6.5).fillColor(isOtherMonthRef ? '#c62828' : COLORS.red);

            const refCols = [
              isOtherMonthRef ? `* ${fmtDate(r.date)}` : fmtDate(r.date),
              r.refundId,
              eur(r.amount),
              eur(r.fee),
              eur(r.net),
              r.description.substring(0, 45),
            ];
            let x = 40;
            for (let j = 0; j < refCols.length; j++) {
              doc.text(refCols[j], x + 2, y + 4, {
                width: pageWidth * refWidths[j] - 4,
                height: 14,
                ellipsis: true,
              });
              x += pageWidth * refWidths[j];
            }
            y += 16;
          }
          y += 5;
        }

        // ── Stripe billing fees table ──
        if (po.stripeBillingFees.length > 0) {
          if (y > 700) { doc.addPage(); y = 40; }

          doc.fontSize(8).fillColor(COLORS.textLight).font('Helvetica-Bold');
          doc.text(`Frais Stripe Billing (${po.stripeBillingFees.length})`, 50, y + 2);
          doc.font('Helvetica').fillColor(COLORS.text);
          y += 14;

          const feeHeaders = ['Date', 'ID Transaction', 'Montant', 'Description'];
          const feeWidths = [0.12, 0.28, 0.13, 0.47];
          y = drawTableHeader(doc, feeHeaders, y, pageWidth, feeWidths);

          for (let fi = 0; fi < po.stripeBillingFees.length; fi++) {
            if (y > 750) {
              doc.addPage();
              y = 40;
              y = drawTableHeader(doc, feeHeaders, y, pageWidth, feeWidths);
            }
            const f = po.stripeBillingFees[fi];
            const bg = fi % 2 === 0 ? COLORS.white : COLORS.lightBg;
            doc.rect(40, y, pageWidth, 16).fill(bg);
            doc.fontSize(6.5).fillColor(COLORS.textLight);

            const feeCols = [fmtDate(f.date), f.txnId, eur(f.amount), f.description];
            let x = 40;
            for (let j = 0; j < feeCols.length; j++) {
              doc.text(feeCols[j], x + 2, y + 4, {
                width: pageWidth * feeWidths[j] - 4,
                height: 14,
                ellipsis: true,
              });
              x += pageWidth * feeWidths[j];
            }
            y += 16;
          }

          // Billing fees subtotal
          const billingTotal = po.stripeBillingFees.reduce((s, f) => s + f.amount, 0);
          doc.rect(40, y, pageWidth, 16).fill(COLORS.textLight);
          doc.fontSize(6.5).fillColor(COLORS.white).font('Helvetica-Bold');
          doc.text(`Total frais billing: ${eur(billingTotal)}`, 42, y + 4, { width: pageWidth - 4 });
          doc.font('Helvetica').fillColor(COLORS.text);
          y += 21;
        }

        // Separator between payouts
        if (pi < payouts.length - 1) {
          y += 10;
          doc.rect(40, y, pageWidth, 1).fill(COLORS.border);
          y += 15;
        }
      }

      // ── Grand total summary ──
      y += 10;
      if (y > 650) { doc.addPage(); y = 40; }

      doc.rect(40, y, pageWidth, 2).fill(COLORS.primary);
      y += 10;

      // ── Compute totals split by current month vs other ──
      let cmCharges = 0, cmFees = 0, cmNet = 0, cmCount = 0;
      let omCharges = 0, omFees = 0, omNet = 0, omCount = 0;
      for (const po of payouts) {
        for (const c of po.charges) {
          const d = new Date(c.date);
          if (d >= reportMonthStart && d < reportMonthEnd) {
            cmCharges += c.grossAmount; cmFees += c.fee; cmNet += c.net; cmCount++;
          } else {
            omCharges += c.grossAmount; omFees += c.fee; omNet += c.net; omCount++;
          }
        }
      }

      const totalPayoutAmount = payouts.reduce((sum, p) => sum + p.amount, 0);
      const totalPayoutBillingFees = payouts.reduce((sum, p) => sum + p.totalBillingFees, 0);
      const totalPayoutRefunds = payouts.reduce((sum, p) => sum + p.totalRefunds, 0);
      const totalPayoutOther = payouts.reduce((sum, p) => sum + p.totalOther, 0);
      const totalBillingCount = payouts.reduce((sum, p) => sum + p.stripeBillingFees.length, 0);

      doc.fontSize(12).fillColor(COLORS.primary).font('Helvetica-Bold');
      doc.text(`TOTAL RECONCILIATION -- ${report.period.label.toUpperCase()}`, 42, y);
      y += 18;

      // Summary table — only current month
      const hasStandalone = (standaloneFees ?? []).length > 0;
      const boxHeight = (omCount > 0 ? 110 : 94) + (hasStandalone ? 14 : 0);
      doc.rect(40, y, pageWidth, boxHeight).fill(COLORS.lightBg);
      doc.fontSize(9).fillColor(COLORS.text);

      const col1 = 55;
      const col2 = 55 + pageWidth * 0.55;
      let sy = y + 6;

      // Payouts line
      doc.font('Helvetica-Bold');
      doc.text(`Virements sur Qonto:`, col1, sy);
      doc.text(`${payouts.length} payout(s) pour ${eur(totalPayoutAmount)}`, col2, sy);
      sy += 16;

      // Current month charges = the real accounting data
      doc.fillColor(COLORS.primary);
      doc.text(`Charges ${report.period.label}:`, col1, sy);
      doc.text(`${cmCount} transaction(s) pour ${eur(cmCharges)} brut`, col2, sy);
      doc.font('Helvetica').fillColor(COLORS.text);
      sy += 14;
      doc.text(`  Frais de processing:`, col1, sy);
      doc.fillColor(COLORS.red);
      doc.text(`-${eur(cmFees)}`, col2, sy);
      doc.fillColor(COLORS.text);
      sy += 14;
      doc.text(`  = Net encaisse (${report.period.label}):`, col1, sy);
      doc.font('Helvetica-Bold').fillColor(COLORS.green);
      doc.text(`${eur(cmNet)}`, col2, sy);
      doc.font('Helvetica').fillColor(COLORS.text);
      sy += 16;

      // Billing fees (in payouts)
      doc.text(`Frais Stripe billing (dans payouts):`, col1, sy);
      doc.fillColor(COLORS.red);
      doc.text(`${eur(totalPayoutBillingFees)}  (${totalBillingCount} ligne(s))`, col2, sy);
      doc.fillColor(COLORS.text);
      sy += 14;

      // Standalone fees
      const standaloneTotal = (standaloneFees ?? []).reduce((s, f) => s + f.amount, 0);
      const standaloneCount = (standaloneFees ?? []).length;
      if (standaloneCount > 0) {
        doc.text(`Frais Stripe independants:`, col1, sy);
        doc.fillColor(COLORS.red);
        doc.text(`${eur(standaloneTotal)}  (${standaloneCount} ligne(s))`, col2, sy);
        doc.fillColor(COLORS.text);
        sy += 14;
      }

      // Total fees
      const allBillingFees = Math.abs(totalPayoutBillingFees) + Math.abs(standaloneTotal);
      doc.font('Helvetica-Bold').fillColor(COLORS.accent);
      doc.text(`TOTAL FRAIS STRIPE (${report.period.label}):`, col1, sy);
      doc.text(`${eur(cmFees + allBillingFees)}`, col2, sy);
      doc.font('Helvetica').fillColor(COLORS.text);

      if (omCount > 0) {
        sy += 16;
        doc.fontSize(8).fillColor('#e65100');
        doc.text(`Charges autre(s) mois incluses dans ces payouts:`, col1, sy);
        doc.text(`${omCount} charge(s) pour ${eur(omCharges)} brut (fees: ${eur(omFees)})`, col2, sy);
        doc.fillColor(COLORS.text);
      }

      y += boxHeight + 8;

      if (totalPayoutRefunds !== 0) {
        doc.fontSize(8).fillColor(COLORS.red);
        doc.text(`Remboursements inclus dans les payouts: ${eur(totalPayoutRefunds)}`, 55, y);
        y += 12;
      }
      if (totalPayoutOther !== 0) {
        doc.fontSize(8).fillColor(COLORS.textLight);
        doc.text(`Reserves Stripe (holds/releases): ${eur(totalPayoutOther)}`, 55, y);
        y += 12;
      }

      y += 8;

      // Legend
      doc.fontSize(7).fillColor(COLORS.textLight);
      doc.text(`Orange = charges d'un autre mois incluses dans un payout de ${report.period.label}`, 55, y);
      y += 10;
      doc.text(`En-tete gris fonce = payout verse en ${nextMonthLabel}, contenant des charges de ${report.period.label}`, 55, y);
      doc.font('Helvetica');
    }

    // ─── STANDALONE STRIPE FEES (not in any payout) ─────────────
    if (standaloneFees && standaloneFees.length > 0) {
      y += 25;
      if (y > 650) { doc.addPage(); y = 40; }

      const standaloneTotal = standaloneFees.reduce((s, f) => s + f.amount, 0);

      doc.rect(40, y, pageWidth, 26).fill(COLORS.primary);
      doc.fontSize(11).fillColor(COLORS.white).font('Helvetica-Bold');
      doc.text('FRAIS STRIPE INDEPENDANTS', 50, y + 3);
      doc.fontSize(8).font('Helvetica');
      doc.text(`${standaloneFees.length} frais non lies a un payout — Billing, Revenue Recognition, Tax API, etc.`, 50, y + 15);
      doc.fillColor(COLORS.text);
      y += 32;

      const sfHeaders = ['Date', 'ID Transaction', 'Montant', 'Description'];
      const sfWidths = [0.12, 0.28, 0.13, 0.47];
      y = drawTableHeader(doc, sfHeaders, y, pageWidth, sfWidths);

      for (let fi = 0; fi < standaloneFees.length; fi++) {
        if (y > 750) {
          doc.addPage();
          y = 40;
          y = drawTableHeader(doc, sfHeaders, y, pageWidth, sfWidths);
        }
        const f = standaloneFees[fi];
        const bg = fi % 2 === 0 ? COLORS.white : COLORS.lightBg;
        doc.rect(40, y, pageWidth, 16).fill(bg);
        doc.fontSize(6.5).fillColor(COLORS.textLight);

        const cols = [fmtDate(f.date), f.txnId, eur(f.amount), f.description];
        let x = 40;
        for (let j = 0; j < cols.length; j++) {
          doc.text(cols[j], x + 2, y + 4, {
            width: pageWidth * sfWidths[j] - 4,
            height: 14,
            ellipsis: true,
          });
          x += pageWidth * sfWidths[j];
        }
        y += 16;
      }

      // Subtotal row
      doc.rect(40, y, pageWidth, 16).fill(COLORS.textLight);
      doc.fontSize(6.5).fillColor(COLORS.white).font('Helvetica-Bold');
      doc.text(`Total frais independants: ${eur(standaloneTotal)} (${standaloneFees.length} ligne(s))`, 42, y + 4, { width: pageWidth - 4 });
      doc.font('Helvetica').fillColor(COLORS.text);
      y += 21;
    }

    // ─── FOOTER ───────────────────────────────────────────
    const pageCount = (doc as any).bufferedPageRange?.()?.count ?? 1;
    // Add footer to all pages
    const range = (doc as any).bufferedPageRange();
    for (let p = range.start; p < range.start + range.count; p++) {
      doc.switchToPage(p);
      doc.fontSize(7).fillColor(COLORS.textLight);
      doc.text(
        `BPA SOLUTIONS — Justificatif Stripe ${report.period.label} — Page ${p - range.start + 1}/${range.count}`,
        40,
        doc.page.height - 30,
        { width: pageWidth, align: 'center' },
      );
    }

    doc.end();

    stream.on('finish', () => resolve(filepath));
    stream.on('error', reject);
  });
}

// ─── Drawing helpers ──────────────────────────────────────

function sectionTitle(doc: PDFKit.PDFDocument, title: string, y: number, width: number): number {
  doc.rect(40, y, 4, 18).fill(COLORS.accent);
  doc.fontSize(12).fillColor(COLORS.primary).font('Helvetica-Bold')
    .text(title, 50, y + 2);
  doc.font('Helvetica');
  return y + 28;
}

function drawSummaryTable(doc: PDFKit.PDFDocument, rows: string[][], y: number, width: number): number {
  for (let i = 0; i < rows.length; i++) {
    const bg = i % 2 === 0 ? COLORS.lightBg : COLORS.white;
    const isTotal = rows[i][0] === 'Revenu net';

    doc.rect(40, y, width, 22).fill(bg);

    if (isTotal) {
      doc.rect(40, y, width, 22).fill(COLORS.primary);
      doc.fontSize(10).fillColor(COLORS.white).font('Helvetica-Bold');
    } else {
      doc.fontSize(9).fillColor(COLORS.text).font('Helvetica');
    }

    doc.text(rows[i][0], 50, y + 5, { width: width * 0.4 });
    doc.text(rows[i][1], 40 + width * 0.4, y + 5, { width: width * 0.3, align: 'right' });
    doc.fontSize(8).fillColor(isTotal ? '#8899bb' : COLORS.textLight);
    doc.text(rows[i][2], 40 + width * 0.72, y + 6, { width: width * 0.28 });

    doc.font('Helvetica').fillColor(COLORS.text);
    y += 22;
  }
  return y;
}

function drawTableHeader(doc: PDFKit.PDFDocument, headers: string[], y: number, width: number, colWidths: number[]): number {
  doc.rect(40, y, width, 18).fill(COLORS.primary);
  doc.fontSize(7).fillColor(COLORS.white).font('Helvetica-Bold');

  let x = 40;
  for (let j = 0; j < headers.length; j++) {
    doc.text(headers[j], x + 2, y + 5, { width: width * colWidths[j] - 4 });
    x += width * colWidths[j];
  }

  doc.font('Helvetica').fillColor(COLORS.text);
  return y + 18;
}

function drawTable(
  doc: PDFKit.PDFDocument,
  headers: string[],
  rows: string[][],
  y: number,
  width: number,
  colWidths: number[],
  boldRows?: boolean[],
): number {
  y = drawTableHeader(doc, headers, y, width, colWidths);

  for (let i = 0; i < rows.length; i++) {
    // Page break if needed — redraw header on new page
    if (y > 740) {
      doc.addPage();
      y = 40;
      y = drawTableHeader(doc, headers, y, width, colWidths);
    }

    const isBold = boldRows?.[i] ?? false;
    // Bold rows: use a slightly darker bg for visual separation
    const bg = isBold ? '#e8eef5' : (i % 2 === 0 ? COLORS.white : COLORS.lightBg);
    doc.rect(40, y, width, 18).fill(bg);
    doc.fontSize(8).fillColor(isBold ? COLORS.primary : COLORS.text).font(isBold ? 'Helvetica-Bold' : 'Helvetica');

    let x = 40;
    for (let j = 0; j < rows[i].length; j++) {
      doc.text(rows[i][j], x + 2, y + 5, { width: width * colWidths[j] - 4 });
      x += width * colWidths[j];
    }
    y += 18;
  }
  doc.font('Helvetica').fillColor(COLORS.text);
  return y;
}
