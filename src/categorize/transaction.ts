import type Stripe from 'stripe';
import type { CategorizedTransaction, SaleCategory } from '../types.js';
import { getPCGMapping, getRefundPCGMapping, getCountryName } from '../config.js';
import { classifyZone } from './geography.js';
import { determineVat, splitTTC } from './vat.js';
import { resolveCustomer } from '../stripe/customers.js';

/**
 * Process a Stripe charge into a categorized accounting transaction.
 */
export async function categorizeCharge(
  charge: Stripe.Charge,
  defaultSaleType: SaleCategory,
  warnings: string[],
): Promise<CategorizedTransaction | null> {
  // Skip failed charges
  if (charge.status !== 'succeeded') return null;

  // Resolve customer
  const customerId = typeof charge.customer === 'string'
    ? charge.customer
    : charge.customer?.id ?? null;
  const customerInfo = await resolveCustomer(customerId, charge);

  if (customerInfo.country === 'UNKNOWN') {
    warnings.push(`Charge ${charge.id}: country unknown, defaulting to France. Manual review needed.`);
    customerInfo.country = 'FR';
  }

  // Geography and VAT
  const zone = classifyZone(customerInfo.country);
  const vatResult = determineVat(zone, customerInfo.isB2B);

  // Get amounts from balance transaction (EUR, authoritative)
  const bt = charge.balance_transaction as Stripe.BalanceTransaction | null;
  let amountTTC: number;
  let stripeFee = 0;
  let netAmount = 0;
  let exchangeRate: number | undefined;

  if (bt && typeof bt === 'object') {
    amountTTC = bt.amount; // in settlement currency (EUR) cents
    stripeFee = bt.fee;
    netAmount = bt.net;
    exchangeRate = bt.exchange_rate ?? undefined;
  } else {
    // Fallback to charge amount (may not be EUR)
    amountTTC = charge.amount;
    warnings.push(`Charge ${charge.id}: no balance transaction, amounts may be inaccurate.`);
  }

  // Split TTC into HT + TVA
  const { amountHT, amountTVA } = splitTTC(amountTTC, vatResult.rate);

  // Determine sale category from product metadata or default
  let saleCategory = defaultSaleType;
  const invoice = charge.invoice as Stripe.Invoice | null;
  if (invoice && typeof invoice === 'object' && invoice.lines?.data?.length) {
    const firstLine = invoice.lines.data[0];
    const meta = firstLine.metadata;
    if (meta?.sale_type) {
      const st = meta.sale_type as SaleCategory;
      if (['marchandises', 'produits_finis', 'services'].includes(st)) {
        saleCategory = st;
      }
    }
  }

  // PCG account
  const pcg = getPCGMapping(saleCategory, zone);

  // Build description
  const desc = buildDescription(charge, customerInfo.name, customerInfo.country);

  return {
    id: charge.id,
    date: new Date(charge.created * 1000).toISOString(),
    type: 'sale',
    saleCategory,
    zone,
    country: customerInfo.country,
    countryName: getCountryName(customerInfo.country),
    isB2B: customerInfo.isB2B,
    vatExempt: vatResult.exempt,
    vatExemptReason: vatResult.exemptReason,
    vatRate: vatResult.rate,
    amountHT,
    amountTVA,
    amountTTC,
    originalCurrency: charge.currency.toUpperCase(),
    originalAmount: charge.amount,
    exchangeRate,
    stripeFee,
    applicationFee: 0,
    netAmount,
    pcgAccount: pcg.account,
    pcgLabel: pcg.label,
    description: desc,
    stripeCustomerId: customerId ?? undefined,
    stripeCustomerName: customerInfo.name,
    stripeCustomerEmail: customerInfo.email,
    stripeInvoiceId: typeof charge.invoice === 'string' ? charge.invoice : (charge.invoice as Stripe.Invoice | null)?.id,
    stripeChargeId: charge.id,
    stripeBalanceTransactionId: typeof charge.balance_transaction === 'string' ? charge.balance_transaction : (bt?.id ?? undefined),
    receiptUrl: charge.receipt_url ?? undefined,
    invoicePdfUrl: invoice && typeof invoice === 'object' ? (invoice.invoice_pdf ?? undefined) : undefined,
    productName: extractProductName(charge),
    metadata: charge.metadata && Object.keys(charge.metadata).length > 0 ? charge.metadata : undefined,
  };
}

/**
 * Process a Stripe refund into a categorized accounting transaction.
 */
export async function categorizeRefund(
  refund: Stripe.Refund,
  defaultSaleType: SaleCategory,
  warnings: string[],
): Promise<CategorizedTransaction | null> {
  if (refund.status !== 'succeeded') return null;

  const charge = refund.charge as Stripe.Charge | null;
  if (!charge || typeof charge === 'string') {
    warnings.push(`Refund ${refund.id}: could not resolve original charge.`);
    return null;
  }

  // Resolve customer from original charge
  const customerId = typeof charge.customer === 'string'
    ? charge.customer
    : charge.customer?.id ?? null;
  const customerInfo = await resolveCustomer(customerId, charge);

  if (customerInfo.country === 'UNKNOWN') {
    customerInfo.country = 'FR';
  }

  const zone = classifyZone(customerInfo.country);
  const vatResult = determineVat(zone, customerInfo.isB2B);

  // Get amounts from balance transaction
  const bt = refund.balance_transaction as Stripe.BalanceTransaction | null;
  let amountTTC: number;
  let stripeFee = 0;
  let netAmount = 0;

  if (bt && typeof bt === 'object') {
    amountTTC = Math.abs(bt.amount);
    stripeFee = bt.fee; // Usually 0 for refunds
    netAmount = bt.net;
  } else {
    amountTTC = refund.amount;
  }

  const { amountHT, amountTVA } = splitTTC(amountTTC, vatResult.rate);
  const pcg = getRefundPCGMapping();

  return {
    id: refund.id,
    date: new Date(refund.created * 1000).toISOString(),
    type: 'refund',
    saleCategory: defaultSaleType,
    zone,
    country: customerInfo.country,
    countryName: getCountryName(customerInfo.country),
    isB2B: customerInfo.isB2B,
    vatExempt: vatResult.exempt,
    vatExemptReason: vatResult.exemptReason,
    vatRate: vatResult.rate,
    amountHT: -amountHT,
    amountTVA: -amountTVA,
    amountTTC: -amountTTC,
    originalCurrency: refund.currency.toUpperCase(),
    originalAmount: -refund.amount,
    stripeFee,
    applicationFee: 0,
    netAmount,
    pcgAccount: pcg.account,
    pcgLabel: pcg.label,
    description: `Remboursement - ${charge.id}`,
    stripeCustomerId: customerId ?? undefined,
    stripeCustomerName: customerInfo.name,
    stripeCustomerEmail: customerInfo.email,
    stripeChargeId: typeof refund.charge === 'string' ? refund.charge : charge.id,
    stripeBalanceTransactionId: typeof refund.balance_transaction === 'string' ? refund.balance_transaction : (bt?.id ?? undefined),
    receiptUrl: charge.receipt_url ?? undefined,
  };
}

function buildDescription(charge: Stripe.Charge, customerName?: string, country?: string): string {
  const parts: string[] = [];
  if (charge.description) parts.push(charge.description);
  if (customerName) parts.push(customerName);
  if (country) parts.push(country);
  if (parts.length === 0) parts.push(charge.id);
  return parts.join(' - ');
}

function extractProductName(charge: Stripe.Charge): string | undefined {
  const invoice = charge.invoice as Stripe.Invoice | null;
  if (invoice && typeof invoice === 'object' && invoice.lines?.data?.length) {
    return invoice.lines.data[0].description ?? undefined;
  }
  return charge.description ?? undefined;
}
