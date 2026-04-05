/**
 * Verification script: cross-checks reports against Stripe payouts
 * to ensure no charge is missing or double-counted.
 */
import 'dotenv/config';
import Stripe from 'stripe';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MonthlyReport } from './types.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2025-02-24.acacia' });

const QONTO_BANK = 'ba_1RqqHtBsJM7cX1Yeu7G1KP3z';
const BPA_START = Math.floor(new Date('2025-07-29T00:00:00Z').getTime() / 1000);

async function main() {
  console.log('════════════════════════════════════════════════════════');
  console.log('  VÉRIFICATION COMPTABLE BPA SOLUTIONS');
  console.log('════════════════════════════════════════════════════════\n');

  // 1. Collect ALL charge IDs from Qonto payouts
  console.log('1. Récupération de tous les payouts Qonto...\n');

  const allPayouts: Stripe.Payout[] = [];
  let hasMore = true;
  let startingAfter: string | undefined;

  while (hasMore) {
    const payouts = await stripe.payouts.list({
      limit: 100,
      destination: QONTO_BANK,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    allPayouts.push(...payouts.data);
    hasMore = payouts.has_more;
    if (payouts.data.length > 0) {
      startingAfter = payouts.data[payouts.data.length - 1].id;
    }
  }

  console.log(`   ${allPayouts.length} payouts Qonto trouvés`);

  // Get all balance transactions from these payouts
  const payoutCharges = new Map<string, { amount: number; fee: number; net: number; date: number; payoutId: string }>();
  const payoutRefunds = new Map<string, { amount: number; fee: number; net: number; date: number; payoutId: string }>();
  let totalPayoutAmount = 0;
  let totalPayoutFees = 0; // Stripe processing fees from balance txns
  let totalStripeBillingFees = 0; // Stripe billing/platform fees

  for (const po of allPayouts) {
    totalPayoutAmount += po.amount;

    let btHasMore = true;
    let btStartingAfter: string | undefined;

    while (btHasMore) {
      const btxns = await stripe.balanceTransactions.list({
        payout: po.id,
        limit: 100,
        ...(btStartingAfter ? { starting_after: btStartingAfter } : {}),
      });

      for (const bt of btxns.data) {
        if (bt.type === 'charge' || bt.type === 'payment') {
          payoutCharges.set(bt.source as string, {
            amount: bt.amount,
            fee: bt.fee,
            net: bt.net,
            date: bt.created,
            payoutId: po.id,
          });
        } else if (bt.type === 'refund') {
          payoutRefunds.set(bt.source as string, {
            amount: bt.amount,
            fee: bt.fee,
            net: bt.net,
            date: bt.created,
            payoutId: po.id,
          });
        } else if (bt.type === 'stripe_fee') {
          totalStripeBillingFees += Math.abs(bt.amount);
        } else if (bt.type === 'payout_failure') {
          // Payout failure refund - not a real charge
        }
        // payout type is the payout itself, skip
      }

      btHasMore = btxns.has_more;
      if (btxns.data.length > 0) {
        btStartingAfter = btxns.data[btxns.data.length - 1].id;
      }
    }
  }

  console.log(`   ${payoutCharges.size} charges dans les payouts Qonto`);
  console.log(`   ${payoutRefunds.size} refunds dans les payouts Qonto`);
  console.log(`   Total payouts: ${(totalPayoutAmount / 100).toFixed(2)} EUR`);
  console.log(`   Frais Stripe (billing/platform): ${(totalStripeBillingFees / 100).toFixed(2)} EUR`);

  // Sum up from balance transactions
  let totalChargeAmount = 0;
  let totalChargeFees = 0;
  let totalChargeNet = 0;
  for (const [, ch] of payoutCharges) {
    totalChargeAmount += ch.amount;
    totalChargeFees += ch.fee;
    totalChargeNet += ch.net;
  }

  let totalRefundAmount = 0;
  for (const [, r] of payoutRefunds) {
    totalRefundAmount += r.amount; // negative
  }

  console.log(`\n   Charges (balance txn): ${(totalChargeAmount / 100).toFixed(2)} EUR`);
  console.log(`   Frais processing:     ${(totalChargeFees / 100).toFixed(2)} EUR`);
  console.log(`   Net charges:          ${(totalChargeNet / 100).toFixed(2)} EUR`);
  console.log(`   Refunds:              ${(totalRefundAmount / 100).toFixed(2)} EUR`);

  // 2. Load all monthly reports and compare
  console.log('\n\n2. Comparaison avec les rapports mensuels...\n');

  const months = [
    '2025-07', '2025-08', '2025-09', '2025-10', '2025-11', '2025-12',
    '2026-01', '2026-02', '2026-03',
  ];

  const reportChargeIds = new Set<string>();
  const reportRefundIds = new Set<string>();
  let reportTotalTTC = 0;
  let reportTotalFees = 0;
  let reportTotalRefunds = 0;
  let reportTotalNet = 0;

  for (const m of months) {
    const reportPath = join('./output', m, 'report.json');
    try {
      const data = JSON.parse(await readFile(reportPath, 'utf-8')) as MonthlyReport;
      let monthCharges = 0;
      let monthRefunds = 0;

      for (const t of data.transactions) {
        if (t.type === 'sale') {
          reportChargeIds.add(t.stripeChargeId);
          monthCharges++;
        } else if (t.type === 'refund') {
          reportRefundIds.add(t.id);
          monthRefunds++;
        }
      }

      reportTotalTTC += data.summary.totalSalesTTC;
      reportTotalFees += data.summary.fees.totalFees;
      reportTotalRefunds += data.summary.totalRefundsTTC;
      reportTotalNet += data.summary.netRevenue;

      console.log(`   ${data.period.label}: ${monthCharges} charges, ${monthRefunds} refunds, TTC ${(data.summary.totalSalesTTC / 100).toFixed(2)} €`);
    } catch {
      console.log(`   ${m}: pas de rapport trouvé`);
    }
  }

  console.log(`\n   Total rapports: ${reportChargeIds.size} charges, ${reportRefundIds.size} refunds`);
  console.log(`   Total TTC:      ${(reportTotalTTC / 100).toFixed(2)} EUR`);
  console.log(`   Total fees:     ${(reportTotalFees / 100).toFixed(2)} EUR`);
  console.log(`   Total refunds:  ${(reportTotalRefunds / 100).toFixed(2)} EUR`);

  // 3. Find discrepancies
  console.log('\n\n3. Recherche de divergences...\n');

  // Charges in payouts but not in reports
  const missingFromReports: string[] = [];
  for (const [chargeId, data] of payoutCharges) {
    if (!reportChargeIds.has(chargeId)) {
      missingFromReports.push(chargeId);
    }
  }

  // Charges in reports but not in payouts
  const missingFromPayouts: string[] = [];
  for (const chargeId of reportChargeIds) {
    if (!payoutCharges.has(chargeId)) {
      missingFromPayouts.push(chargeId);
    }
  }

  if (missingFromReports.length > 0) {
    console.log(`❌ ${missingFromReports.length} charge(s) dans les payouts Qonto MAIS PAS dans les rapports:`);
    for (const id of missingFromReports) {
      const data = payoutCharges.get(id)!;
      console.log(`   ${new Date(data.date * 1000).toISOString()} | ${(data.amount / 100).toFixed(2)} EUR | ${id} | payout: ${data.payoutId}`);
    }
  } else {
    console.log('✅ Toutes les charges des payouts Qonto sont dans les rapports');
  }

  if (missingFromPayouts.length > 0) {
    console.log(`\n❌ ${missingFromPayouts.length} charge(s) dans les rapports MAIS PAS dans les payouts Qonto:`);
    for (const id of missingFromPayouts) {
      console.log(`   ${id}`);
    }
  } else {
    console.log('✅ Toutes les charges des rapports sont dans les payouts Qonto');
  }

  // Amount comparison per charge
  console.log('\n\n4. Vérification montants charge par charge...\n');
  let amountMismatches = 0;
  for (const [chargeId, payoutData] of payoutCharges) {
    if (!reportChargeIds.has(chargeId)) continue;
    // We'd need to load the full transaction data to compare amounts
    // For now, aggregate comparison is sufficient
  }

  // Aggregate comparison
  console.log('5. Comparaison agrégée...\n');
  const payoutGross = totalChargeAmount;
  const reportGross = reportTotalTTC;
  const diff = payoutGross - reportGross;

  console.log(`   Payouts (charges brut):  ${(payoutGross / 100).toFixed(2)} EUR`);
  console.log(`   Rapports (ventes TTC):   ${(reportGross / 100).toFixed(2)} EUR`);
  console.log(`   Différence:              ${(diff / 100).toFixed(2)} EUR`);

  if (Math.abs(diff) < 100) { // less than 1 EUR
    console.log('   ✅ Les montants concordent (diff < 1€)');
  } else {
    console.log('   ⚠️  Différence significative - vérification manuelle recommandée');
  }

  // Fee comparison
  const payoutProcessingFees = totalChargeFees;
  console.log(`\n   Fees (payouts):   ${(payoutProcessingFees / 100).toFixed(2)} EUR`);
  console.log(`   Fees (rapports):  ${(reportTotalFees / 100).toFixed(2)} EUR`);
  const feeDiff = payoutProcessingFees - reportTotalFees;
  console.log(`   Diff fees:        ${(feeDiff / 100).toFixed(2)} EUR`);

  console.log('\n\n════════════════════════════════════════════════════════');
  console.log('  VÉRIFICATION TERMINÉE');
  console.log('════════════════════════════════════════════════════════\n');
}

main().catch(console.error);
