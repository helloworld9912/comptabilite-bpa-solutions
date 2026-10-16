import { Command } from 'commander';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import 'dotenv/config';

import type { SaleCategory, CategorizedTransaction } from './types.js';
import { MONTH_NAMES_FR, BPA_SOLUTIONS_START_UNIX, QONTO_BANK_ACCOUNT_ID } from './config.js';
import { fetchCharges, fetchRefunds, fetchDisputes, type MonthRange } from './stripe/fetcher.js';
import { clearCustomerCache } from './stripe/customers.js';
import { categorizeCharge, categorizeRefund, categorizeDispute } from './categorize/transaction.js';
import { buildReport, centsToEur } from './output/report.js';
import { generateTransactionsCsv, generateSummaryCsv, generateCountryCsv } from './output/csv.js';
import { downloadReceipts } from './output/receipts.js';
import { generateMonthlyPdf } from './output/pdf-justificatif.js';
import { fetchPayoutReconciliation, fetchStandaloneStripeFees } from './stripe/payouts.js';
import { runReport as runStripeReport, monthInterval, STATEMENT_REPORTS } from './stripe/reports.js';
import { generateStripeStatementPdf } from './output/pdf-statement.js';
import { getStripe } from './stripe/client.js';

const program = new Command();

program
  .name('compta-stripe')
  .description('Comptabilité BPA SOLUTIONS - Rapports mensuels Stripe')
  .version('1.0.0');

program
  .command('report')
  .description('Générer le rapport mensuel')
  .argument('<month>', 'Mois au format YYYY-MM (ex: 2026-01)')
  .option('-o, --output <dir>', 'Dossier de sortie', './output')
  .option('-f, --format <format>', 'Format: json, csv, both', 'both')
  .option('-t, --sale-type <type>', 'Type de vente par défaut: marchandises, produits_finis, services', 'services')
  .option('--dry-run', 'Lire les données sans écrire de fichiers', false)
  .option('-v, --verbose', 'Afficher les détails', false)
  .action(async (monthStr: string, opts) => {
    try {
      await runReport(monthStr, opts);
    } catch (err) {
      console.error('\nErreur:', err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

program
  .command('fiscal-year')
  .description('Générer tous les rapports de l\'exercice BPA SOLUTIONS (29 juil 2025 → 31 mar 2026)')
  .option('-o, --output <dir>', 'Dossier de sortie', './output')
  .option('-t, --sale-type <type>', 'Type de vente par défaut', 'services')
  .option('-v, --verbose', 'Afficher les détails', false)
  .action(async (opts) => {
    try {
      await runFiscalYear(opts);
    } catch (err) {
      console.error('\nErreur:', err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

program
  .command('receipts')
  .description('Télécharger les justificatifs (factures PDF)')
  .argument('<month>', 'Mois au format YYYY-MM')
  .option('-o, --output <dir>', 'Dossier de sortie', './output')
  .option('-t, --sale-type <type>', 'Type de vente par défaut', 'services')
  .option('-v, --verbose', 'Afficher les détails', false)
  .action(async (monthStr: string, opts) => {
    try {
      await runReceipts(monthStr, opts);
    } catch (err) {
      console.error('\nErreur:', err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

program
  .command('statement')
  .description('Générer le relevé de compte Stripe mensuel (solde, virements, transactions/frais) via Stripe Financial Reports')
  .argument('<month>', 'Mois au format YYYY-MM (ex: 2026-09)')
  .option('-o, --output <dir>', 'Dossier de sortie', './output')
  .option('-v, --verbose', 'Afficher les détails', false)
  .action(async (monthStr: string, opts) => {
    try {
      await runStatement(monthStr, opts);
    } catch (err) {
      console.error('\nErreur:', err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

program.parse();

// ─── Fiscal Year Command ────────────────────────────────────────────────────

async function runFiscalYear(opts: {
  output: string;
  saleType: string;
  verbose: boolean;
}) {
  console.log('\n════════════════════════════════════════════════════════');
  console.log('  EXERCICE COMPTABLE BPA SOLUTIONS');
  console.log('  29 juillet 2025 → 31 mars 2026');
  console.log('════════════════════════════════════════════════════════\n');

  const months = [
    '2025-07', '2025-08', '2025-09', '2025-10', '2025-11', '2025-12',
    '2026-01', '2026-02', '2026-03',
  ];

  const allReports: { month: string; report: ReturnType<typeof buildReport> }[] = [];

  for (const m of months) {
    const report = await runReport(m, {
      output: opts.output,
      format: 'both',
      saleType: opts.saleType,
      dryRun: false,
      verbose: opts.verbose,
    });
    if (report) {
      allReports.push({ month: m, report });
    }
  }

  // Print fiscal year totals
  console.log('\n\n════════════════════════════════════════════════════════');
  console.log('  RÉCAPITULATIF EXERCICE COMPTABLE');
  console.log('════════════════════════════════════════════════════════\n');

  let totalSalesHT = 0, totalTVA = 0, totalSalesTTC = 0;
  let totalRefundsTTC = 0, totalFees = 0, totalNet = 0;
  let totalTxns = 0;

  for (const { month, report } of allReports) {
    const s = report.summary;
    totalSalesHT += s.totalSalesHT;
    totalTVA += s.totalTVA;
    totalSalesTTC += s.totalSalesTTC;
    totalRefundsTTC += s.totalRefundsTTC;
    totalFees += s.fees.totalFees;
    totalNet += s.netRevenue;
    totalTxns += report.transactions.length;

    console.log(`${report.period.label.padEnd(20)} | ${String(report.transactions.length).padStart(4)} txn | TTC ${centsToEur(s.totalSalesTTC).padStart(10)} € | HT ${centsToEur(s.totalSalesHT).padStart(10)} € | TVA ${centsToEur(s.totalTVA).padStart(8)} € | Fees ${centsToEur(s.fees.totalFees).padStart(8)} €`);
  }

  console.log('─'.repeat(110));
  console.log(`${'TOTAL'.padEnd(20)} | ${String(totalTxns).padStart(4)} txn | TTC ${centsToEur(totalSalesTTC).padStart(10)} € | HT ${centsToEur(totalSalesHT).padStart(10)} € | TVA ${centsToEur(totalTVA).padStart(8)} € | Fees ${centsToEur(totalFees).padStart(8)} €`);
  console.log(`\nRemboursements total: ${centsToEur(totalRefundsTTC)} €`);
  console.log(`Revenu net total:     ${centsToEur(totalNet)} €`);

  // Write fiscal year summary
  const summaryPath = join(opts.output, 'fiscal-year-summary.json');
  await writeFile(summaryPath, JSON.stringify({
    period: { start: '2025-07-29', end: '2026-03-31' },
    entity: 'BPA SOLUTIONS',
    generatedAt: new Date().toISOString(),
    totalSalesHT,
    totalTVA,
    totalSalesTTC,
    totalRefundsTTC,
    totalFees,
    totalNet,
    totalTransactions: totalTxns,
    months: allReports.map(r => ({
      label: r.report.period.label,
      ...r.report.summary,
      transactionCount: r.report.transactions.length,
    })),
  }, null, 2), 'utf-8');
  console.log(`\n📁 Résumé exercice: ${summaryPath}`);
}

// ─── Report Command ─────────────────────────────────────────────────────────

async function runReport(monthStr: string, opts: {
  output: string;
  format: string;
  saleType: string;
  dryRun: boolean;
  verbose: boolean;
}): Promise<ReturnType<typeof buildReport> | null> {
  const { year, month, range } = parseMonth(monthStr);
  const saleType = opts.saleType as SaleCategory;

  console.log(`\n📊 Rapport comptable - ${MONTH_NAMES_FR[month - 1]} ${year}`);
  console.log('─'.repeat(50));

  // Fetch data
  console.log('⏳ Récupération des données Stripe...');

  // Also fetch next month's payouts to find payouts that contain charges from this month
  const nextMonthStart = new Date(Date.UTC(year, month, 1)); // month is already 1-based, so this is next month
  const nextMonthEnd = new Date(Date.UTC(year, month, 16)); // first 15 days of next month
  const nextMonthRange = {
    gte: Math.floor(nextMonthStart.getTime() / 1000),
    lt: Math.floor(nextMonthEnd.getTime() / 1000),
  };

  const [charges, refunds, disputes, payoutsCurrent, payoutsNextMonth, standaloneStripeFees] = await Promise.all([
    fetchCharges(range),
    fetchRefunds(range),
    fetchDisputes(range),
    fetchPayoutReconciliation(range),
    fetchPayoutReconciliation(nextMonthRange),
    fetchStandaloneStripeFees(range),
  ]);

  // Filter payouts to only Qonto bank account
  const qontoCurrentMonth = payoutsCurrent.filter(p => p.destination === QONTO_BANK_ACCOUNT_ID);

  // From next month's payouts, keep only those containing charges dated in current month
  const monthStart = new Date(Date.UTC(year, month - 1, 1));
  const monthEnd = new Date(Date.UTC(year, month, 1));
  const qontoOverflow = payoutsNextMonth
    .filter(p => p.destination === QONTO_BANK_ACCOUNT_ID)
    .filter(p => {
      // Check if any charge/refund in this payout is dated within the current month
      const hasCurrentMonthCharge = p.charges.some(c => {
        const d = new Date(c.date);
        return d >= monthStart && d < monthEnd;
      });
      const hasCurrentMonthRefund = p.refunds.some(r => {
        const d = new Date(r.date);
        return d >= monthStart && d < monthEnd;
      });
      return hasCurrentMonthCharge || hasCurrentMonthRefund;
    });

  const qontoPayouts = [...qontoCurrentMonth, ...qontoOverflow];
  console.log(`   ${qontoCurrentMonth.length} payouts Qonto ce mois + ${qontoOverflow.length} du mois suivant (contenant des charges de ce mois)`);

  // Filter standalone fees: remove those already captured in payout reconciliation
  const payoutFeeIds = new Set(
    qontoPayouts.flatMap(p => p.stripeBillingFees.map(f => f.txnId))
  );
  const standaloneFees = standaloneStripeFees.filter(f => !payoutFeeIds.has(f.txnId));
  if (standaloneFees.length > 0) {
    console.log(`   ${standaloneFees.length} frais Stripe indépendants (non liés à un payout)`)
  }

  // Filter: only charges from BPA SOLUTIONS era (>= 2025-07-29)
  const filteredCharges = charges.filter(ch => ch.created >= BPA_SOLUTIONS_START_UNIX);
  const filteredRefunds = refunds.filter(r => r.created >= BPA_SOLUTIONS_START_UNIX);
  const filteredDisputes = disputes.filter(d => d.created >= BPA_SOLUTIONS_START_UNIX);

  const skippedCharges = charges.length - filteredCharges.length;
  const skippedRefunds = refunds.length - filteredRefunds.length;

  console.log(`   ${filteredCharges.length} charges, ${filteredRefunds.length} remboursements, ${filteredDisputes.length} litiges`);
  if (skippedCharges > 0 || skippedRefunds > 0) {
    console.log(`   (${skippedCharges} charges et ${skippedRefunds} remboursements ignorés - auto-entreprise)`);
  }

  if (filteredCharges.length === 0 && filteredRefunds.length === 0 && filteredDisputes.length === 0) {
    console.log('   Aucune transaction BPA SOLUTIONS pour ce mois.');
    return null;
  }

  // Categorize
  console.log('🔍 Catégorisation...');
  const warnings: string[] = [];
  const transactions: CategorizedTransaction[] = [];

  for (const charge of filteredCharges) {
    const t = await categorizeCharge(charge, saleType, warnings);
    if (t) transactions.push(t);
  }

  for (const refund of filteredRefunds) {
    const t = await categorizeRefund(refund, saleType, warnings);
    if (t) transactions.push(t);
  }

  for (const dispute of filteredDisputes) {
    const t = await categorizeDispute(dispute, saleType, warnings);
    if (t) transactions.push(t);
  }

  transactions.sort((a, b) => a.date.localeCompare(b.date));
  console.log(`   ${transactions.length} transactions catégorisées`);

  const report = buildReport(year, month, transactions, warnings);

  printSummary(report);

  if (warnings.length > 0) {
    console.log(`\n⚠️  ${warnings.length} avertissement(s):`);
    for (const w of warnings.slice(0, 10)) {
      console.log(`   - ${w}`);
    }
    if (warnings.length > 10) {
      console.log(`   ... et ${warnings.length - 10} autres`);
    }
  }

  if (opts.dryRun) {
    console.log('\n(Dry run - aucun fichier écrit)');
    return report;
  }

  // Write output files
  const outputDir = join(opts.output, `${year}-${String(month).padStart(2, '0')}`);
  await mkdir(outputDir, { recursive: true });

  const format = opts.format;
  const filesWritten: string[] = [];

  if (format === 'json' || format === 'both') {
    const jsonPath = join(outputDir, 'report.json');
    await writeFile(jsonPath, JSON.stringify(report, null, 2), 'utf-8');
    filesWritten.push(jsonPath);
  }

  if (format === 'csv' || format === 'both') {
    const txnCsvPath = join(outputDir, 'transactions.csv');
    await writeFile(txnCsvPath, generateTransactionsCsv(report), 'utf-8');
    filesWritten.push(txnCsvPath);

    const sumCsvPath = join(outputDir, 'summary.csv');
    await writeFile(sumCsvPath, generateSummaryCsv(report), 'utf-8');
    filesWritten.push(sumCsvPath);

    const countryCsvPath = join(outputDir, 'by_country.csv');
    await writeFile(countryCsvPath, generateCountryCsv(report), 'utf-8');
    filesWritten.push(countryCsvPath);
  }

  // Always generate PDF justificatif (with payout reconciliation)
  const pdfPath = await generateMonthlyPdf(report, outputDir, qontoPayouts, standaloneFees);
  filesWritten.push(pdfPath);

  console.log('📁 Fichiers: ' + filesWritten.map(f => f.split('/').slice(-2).join('/')).join(', '));

  clearCustomerCache();
  return report;
}

// ─── Receipts Command ───────────────────────────────────────────────────────

async function runReceipts(monthStr: string, opts: {
  output: string;
  saleType: string;
  verbose: boolean;
}) {
  const { year, month, range } = parseMonth(monthStr);
  const saleType = opts.saleType as SaleCategory;

  console.log(`\n📄 Téléchargement des justificatifs - ${MONTH_NAMES_FR[month - 1]} ${year}`);
  console.log('─'.repeat(50));

  console.log('⏳ Récupération des données Stripe...');
  const charges = await fetchCharges(range);
  const filteredCharges = charges.filter(ch => ch.created >= BPA_SOLUTIONS_START_UNIX);

  const warnings: string[] = [];
  const transactions: CategorizedTransaction[] = [];
  for (const charge of filteredCharges) {
    const t = await categorizeCharge(charge, saleType, warnings);
    if (t) transactions.push(t);
  }

  const outputDir = join(opts.output, `${year}-${String(month).padStart(2, '0')}`);
  await mkdir(outputDir, { recursive: true });

  console.log(`⏳ Téléchargement de ${transactions.length} justificatifs...`);
  const result = await downloadReceipts(transactions, outputDir, opts.verbose);

  console.log(`✅ ${result.downloaded} factures PDF téléchargées`);
  console.log(`   URLs des reçus: ${result.urlsFile}`);
  if (result.failed.length > 0) {
    console.log(`⚠️  ${result.failed.length} échec(s)`);
  }

  clearCustomerCache();
}

// ─── Statement Command (relevé Stripe) ───────────────────────────────────────

async function runStatement(monthStr: string, opts: {
  output: string;
  verbose: boolean;
}) {
  const { year, month } = parseMonth(monthStr);
  const mm = String(month).padStart(2, '0');

  console.log(`\n🏦 Relevé de compte Stripe - ${MONTH_NAMES_FR[month - 1]} ${year}`);
  console.log('─'.repeat(50));
  console.log('⏳ Génération des rapports Stripe (Financial Reports)...');

  const interval = monthInterval(year, month);
  const [balance, payouts, activity] = await Promise.all([
    runStripeReport(STATEMENT_REPORTS.balance, interval, { verbose: opts.verbose }),
    runStripeReport(STATEMENT_REPORTS.payouts, interval, { verbose: opts.verbose }),
    runStripeReport(STATEMENT_REPORTS.activity, interval, { verbose: opts.verbose }),
  ]);

  const outputDir = join(opts.output, `${year}-${mm}`);
  const reportsDir = join(outputDir, 'stripe-reports');
  await mkdir(reportsDir, { recursive: true });

  const filesWritten: string[] = [];
  const csvFiles: [string, string][] = [
    [`balance_summary_${year}-${mm}.csv`, balance.csv],
    [`payouts_${year}-${mm}.csv`, payouts.csv],
    [`balance_change_from_activity_${year}-${mm}.csv`, activity.csv],
  ];
  for (const [name, csv] of csvFiles) {
    const p = join(reportsDir, name);
    await writeFile(p, csv, 'utf-8');
    filesWritten.push(p);
  }

  const account = await getStripe().accounts.retrieve();
  const pdfPath = await generateStripeStatementPdf({
    year,
    month,
    accountId: account.id,
    generatedAt: new Date().toISOString(),
    balance: balance.rows,
    payouts: payouts.rows,
    activity: activity.rows,
  }, outputDir);
  filesWritten.push(pdfPath);

  // Summary
  const eurRow = (cat: string) => balance.rows.find(r => r.category === cat && r.currency === 'eur');
  const fmt = (v?: string) => (v ? parseFloat(v).toFixed(2) : '-');
  console.log(`\n💰 Solde EUR: ${fmt(eurRow('starting_balance')?.net_amount)} € → ${fmt(eurRow('ending_balance')?.net_amount)} €`);
  console.log(`   Activité nette: ${fmt(eurRow('activity')?.net_amount)} € | Virements: ${fmt(eurRow('payouts')?.net_amount)} €`);
  const payoutTotal = payouts.rows.reduce((s, p) => s + parseFloat(p.net || '0'), 0);
  console.log(`   ${payouts.rows.length} virement(s) pour ${payoutTotal.toFixed(2)} € | ${activity.rows.length} mouvement(s)`);
  console.log('📁 Fichiers: ' + filesWritten.map(f => f.split('/').slice(-2).join('/')).join(', '));
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function parseMonth(monthStr: string): { year: number; month: number; range: MonthRange } {
  const match = monthStr.match(/^(\d{4})-(\d{2})$/);
  if (!match) {
    throw new Error(`Format invalide: "${monthStr}". Utilisez YYYY-MM (ex: 2026-01)`);
  }
  const year = parseInt(match[1], 10);
  const month = parseInt(match[2], 10);
  if (month < 1 || month > 12) {
    throw new Error(`Mois invalide: ${month}`);
  }

  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 1));

  return {
    year,
    month,
    range: {
      gte: Math.floor(start.getTime() / 1000),
      lt: Math.floor(end.getTime() / 1000),
    },
  };
}

function printSummary(report: ReturnType<typeof buildReport>): void {
  const s = report.summary;
  console.log(`\n💰 Résumé - ${report.period.label}`);
  console.log('─'.repeat(50));
  console.log(`   Ventes TTC:          ${centsToEur(s.totalSalesTTC).padStart(12)} €`);
  console.log(`   Ventes HT:           ${centsToEur(s.totalSalesHT).padStart(12)} €`);
  console.log(`   TVA collectée:       ${centsToEur(s.totalTVA).padStart(12)} €`);
  if (s.totalRefundsTTC !== 0) {
    console.log(`   Remboursements TTC:  ${centsToEur(s.totalRefundsTTC).padStart(12)} €`);
  }
  console.log(`   Commissions Stripe:  ${centsToEur(s.fees.stripeFees).padStart(12)} €`);
  if (s.fees.applicationFees > 0) {
    console.log(`   Frais application:   ${centsToEur(s.fees.applicationFees).padStart(12)} €`);
  }
  console.log(`   Revenu net:          ${centsToEur(s.netRevenue).padStart(12)} €`);

  // By zone
  console.log(`\n📍 Par zone:`);
  for (const [, zone] of Object.entries(report.byZone)) {
    console.log(`   ${zone.label}: ${zone.count} txn, ${centsToEur(zone.totalTTC)} € TTC`);
    for (const [code, data] of Object.entries(zone.countries)) {
      console.log(`     └ ${code}: ${data.count} txn, ${centsToEur(data.totalTTC)} € TTC`);
    }
  }

  // By VAT rate
  console.log(`\n📊 Par taux de TVA:`);
  for (const [, vat] of Object.entries(report.byVatRate)) {
    console.log(`   ${vat.label}: ${vat.count} txn, HT ${centsToEur(vat.totalHT)} €, TVA ${centsToEur(vat.totalTVA)} €`);
  }

  // By PCG account
  console.log(`\n📒 Par compte comptable:`);
  for (const [, cat] of Object.entries(report.byCategory)) {
    console.log(`   ${cat.pcgAccount} - ${cat.label}: ${centsToEur(cat.totalTTC)} € (${cat.count} txn)`);
  }
}
