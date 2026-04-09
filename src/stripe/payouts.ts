import type Stripe from 'stripe';
import { getStripe, fetchAll } from './client.js';
import type { MonthRange } from './fetcher.js';

export interface PayoutDetail {
  payoutId: string;
  date: string; // ISO
  amount: number; // cents EUR (net amount paid out)
  status: string;
  destination: string; // bank account ID
  charges: PayoutCharge[];
  refunds: PayoutRefund[];
  stripeBillingFees: PayoutFee[];
  otherTransactions: PayoutOther[];
  totalCharges: number;
  totalRefunds: number;
  totalFees: number; // processing fees on charges
  totalBillingFees: number; // stripe billing/platform fees
  totalOther: number; // balance holds, releases, adjustments, etc.
}

export interface PayoutCharge {
  chargeId: string;
  date: string;
  grossAmount: number; // cents EUR
  fee: number;
  net: number;
  description: string;
}

export interface PayoutRefund {
  refundId: string;
  date: string;
  amount: number; // negative cents EUR
  fee: number;
  net: number;
  description: string;
}

export interface PayoutFee {
  txnId: string; // balance transaction ID (txn_...)
  date: string;
  amount: number; // negative cents
  description: string;
}

export interface PayoutOther {
  type: string;
  date: string;
  amount: number;
  description: string;
}

/**
 * Fetch all payouts for a month and their associated balance transactions.
 * This gives a full reconciliation: payout amount = sum of charges - fees - refunds - billing fees.
 */
export async function fetchPayoutReconciliation(range: MonthRange): Promise<PayoutDetail[]> {
  const stripe = getStripe();
  const payouts: Stripe.Payout[] = [];

  for await (const payout of fetchAll(
    (params) => stripe.payouts.list(params as Stripe.PayoutListParams),
    { arrival_date: { gte: range.gte, lt: range.lt } },
  )) {
    payouts.push(payout);
  }

  const results: PayoutDetail[] = [];

  for (const po of payouts) {
    const charges: PayoutCharge[] = [];
    const refunds: PayoutRefund[] = [];
    const billingFees: PayoutFee[] = [];
    const otherTransactions: PayoutOther[] = [];
    let totalCharges = 0;
    let totalRefunds = 0;
    let totalFees = 0;
    let totalBillingFees = 0;
    let totalOther = 0;

    // Fetch all balance transactions for this payout
    let hasMore = true;
    let startingAfter: string | undefined;

    while (hasMore) {
      const btxns = await stripe.balanceTransactions.list({
        payout: po.id,
        limit: 100,
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      });

      for (const bt of btxns.data) {
        if (bt.type === 'charge' || bt.type === 'payment') {
          charges.push({
            chargeId: bt.source as string,
            date: new Date(bt.created * 1000).toISOString(),
            grossAmount: bt.amount,
            fee: bt.fee,
            net: bt.net,
            description: bt.description ?? '',
          });
          totalCharges += bt.amount;
          totalFees += bt.fee;
        } else if (bt.type === 'refund') {
          refunds.push({
            refundId: bt.source as string,
            date: new Date(bt.created * 1000).toISOString(),
            amount: bt.amount, // negative
            fee: bt.fee,
            net: bt.net,
            description: bt.description ?? '',
          });
          totalRefunds += bt.amount;
        } else if (bt.type === 'stripe_fee') {
          billingFees.push({
            txnId: bt.id,
            date: new Date(bt.created * 1000).toISOString(),
            amount: bt.amount, // negative
            description: bt.description ?? '',
          });
          totalBillingFees += bt.amount;
        } else if (bt.type === 'payout_failure') {
          billingFees.push({
            txnId: bt.id,
            date: new Date(bt.created * 1000).toISOString(),
            amount: bt.amount,
            description: bt.description ?? 'Payout failure refund',
          });
          totalBillingFees += bt.amount;
        } else if (bt.type !== 'payout') {
          // Catch-all for other types: payout_minimum_balance_hold, payout_minimum_balance_release,
          // adjustment, application_fee, etc.
          otherTransactions.push({
            type: bt.type,
            date: new Date(bt.created * 1000).toISOString(),
            amount: bt.amount,
            description: bt.description ?? bt.type,
          });
          totalOther += bt.amount;
        }
      }

      hasMore = btxns.has_more;
      if (btxns.data.length > 0) {
        startingAfter = btxns.data[btxns.data.length - 1].id;
      }
    }

    // Sort charges by date
    charges.sort((a, b) => a.date.localeCompare(b.date));

    results.push({
      payoutId: po.id,
      date: new Date(po.created * 1000).toISOString(),
      amount: po.amount,
      status: po.status,
      destination: typeof po.destination === 'string' ? po.destination : po.destination?.id ?? '',
      charges,
      refunds,
      stripeBillingFees: billingFees,
      otherTransactions,
      totalCharges,
      totalRefunds,
      totalFees,
      totalBillingFees,
      totalOther,
    });
  }

  // Sort payouts by date
  results.sort((a, b) => a.date.localeCompare(b.date));
  return results;
}

/**
 * Fetch all standalone stripe_fee balance transactions for a month.
 * These are fees (Billing, Revenue Recognition, Tax API, Automatic Taxes)
 * that are NOT part of any payout — they're deducted directly from the Stripe balance.
 */
export async function fetchStandaloneStripeFees(range: MonthRange): Promise<PayoutFee[]> {
  const stripe = getStripe();
  const fees: PayoutFee[] = [];

  for await (const bt of fetchAll(
    (params) => stripe.balanceTransactions.list(params as Stripe.BalanceTransactionListParams),
    { created: { gte: range.gte, lt: range.lt }, type: 'stripe_fee' },
  )) {
    fees.push({
      txnId: bt.id,
      date: new Date(bt.created * 1000).toISOString(),
      amount: bt.amount,
      description: bt.description ?? '',
    });
  }

  // Sort by date ascending
  fees.sort((a, b) => a.date.localeCompare(b.date));
  return fees;
}
