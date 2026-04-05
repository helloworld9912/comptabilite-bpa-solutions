import type Stripe from 'stripe';
import { getStripe, fetchAll } from './client.js';

export interface MonthRange {
  gte: number; // Unix timestamp start of month
  lt: number;  // Unix timestamp start of next month
}

/**
 * Fetch all charges for a month, with expanded balance_transaction and invoice.
 */
export async function fetchCharges(range: MonthRange): Promise<Stripe.Charge[]> {
  const stripe = getStripe();
  const charges: Stripe.Charge[] = [];

  for await (const charge of fetchAll(
    (params) => stripe.charges.list(params as Stripe.ChargeListParams),
    {
      created: { gte: range.gte, lt: range.lt },
      expand: ['data.balance_transaction', 'data.invoice', 'data.customer'],
    },
  )) {
    charges.push(charge);
  }

  return charges;
}

/**
 * Fetch all refunds for a month.
 */
export async function fetchRefunds(range: MonthRange): Promise<Stripe.Refund[]> {
  const stripe = getStripe();
  const refunds: Stripe.Refund[] = [];

  for await (const refund of fetchAll(
    (params) => stripe.refunds.list(params as Stripe.RefundListParams),
    {
      created: { gte: range.gte, lt: range.lt },
      expand: ['data.charge', 'data.balance_transaction'],
    },
  )) {
    refunds.push(refund);
  }

  return refunds;
}

/**
 * Fetch all balance transactions for a month (for fee reconciliation).
 */
export async function fetchBalanceTransactions(range: MonthRange): Promise<Stripe.BalanceTransaction[]> {
  const stripe = getStripe();
  const txns: Stripe.BalanceTransaction[] = [];

  for await (const txn of fetchAll(
    (params) => stripe.balanceTransactions.list(params as Stripe.BalanceTransactionListParams),
    {
      created: { gte: range.gte, lt: range.lt },
    },
  )) {
    txns.push(txn);
  }

  return txns;
}

/**
 * Fetch all payouts for a month.
 */
export async function fetchPayouts(range: MonthRange): Promise<Stripe.Payout[]> {
  const stripe = getStripe();
  const payouts: Stripe.Payout[] = [];

  for await (const payout of fetchAll(
    (params) => stripe.payouts.list(params as Stripe.PayoutListParams),
    {
      created: { gte: range.gte, lt: range.lt },
    },
  )) {
    payouts.push(payout);
  }

  return payouts;
}

/**
 * Fetch invoice PDF URL for a given invoice ID.
 */
export async function getInvoicePdfUrl(invoiceId: string): Promise<string | null> {
  const stripe = getStripe();
  try {
    const invoice = await stripe.invoices.retrieve(invoiceId);
    return invoice.invoice_pdf ?? null;
  } catch {
    return null;
  }
}
