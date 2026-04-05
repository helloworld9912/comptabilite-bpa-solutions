export interface CustomerInfo {
  customerId: string;
  country: string; // ISO 3166-1 alpha-2
  vatId?: string;
  isB2B: boolean;
  name?: string;
  email?: string;
}

export type SaleCategory = 'marchandises' | 'produits_finis' | 'services';
export type GeoZone = 'france' | 'ue' | 'hors_ue';
export type TransactionType = 'sale' | 'refund' | 'fee' | 'payout' | 'adjustment';

export interface CategorizedTransaction {
  id: string;
  date: string; // ISO date
  type: TransactionType;

  // Sale categorization
  saleCategory: SaleCategory;
  zone: GeoZone;
  country: string; // ISO 3166-1 alpha-2
  countryName: string;
  isB2B: boolean;
  vatExempt: boolean;
  vatExemptReason?: 'reverse_charge' | 'export' | 'legal_exemption';
  vatRate: number; // 0.20, 0.10, 0.055, or 0

  // Amounts in cents, settlement currency (EUR)
  amountHT: number;
  amountTVA: number;
  amountTTC: number;

  // Original charge currency
  originalCurrency: string;
  originalAmount: number; // in original currency cents
  exchangeRate?: number;

  // Fees in cents EUR
  stripeFee: number;
  applicationFee: number;
  netAmount: number;

  // Accounting
  pcgAccount: string;
  pcgLabel: string;
  description: string;

  // Stripe references
  stripeCustomerId?: string;
  stripeCustomerName?: string;
  stripeCustomerEmail?: string;
  stripeInvoiceId?: string;
  stripeChargeId: string;
  stripeBalanceTransactionId?: string;
  receiptUrl?: string;
  invoicePdfUrl?: string;

  // Metadata
  productName?: string;
  metadata?: Record<string, string>;
}

export interface CategorySummary {
  label: string;
  pcgAccount: string;
  count: number;
  totalHT: number;
  totalTVA: number;
  totalTTC: number;
}

export interface ZoneSummary {
  zone: GeoZone;
  label: string;
  count: number;
  totalHT: number;
  totalTVA: number;
  totalTTC: number;
  countries: Record<string, { count: number; totalTTC: number }>;
}

export interface VatRateSummary {
  rate: number;
  label: string;
  count: number;
  totalHT: number;
  totalTVA: number;
  totalTTC: number;
}

export interface FeeSummary {
  stripeFees: number;
  applicationFees: number;
  totalFees: number;
}

export interface MonthlyReport {
  period: {
    year: number;
    month: number;
    label: string; // "Janvier 2026"
    startDate: string;
    endDate: string;
  };
  generatedAt: string;
  currency: string;
  summary: {
    totalSalesHT: number;
    totalTVA: number;
    totalSalesTTC: number;
    totalRefundsHT: number;
    totalRefundsTVA: number;
    totalRefundsTTC: number;
    fees: FeeSummary;
    netRevenue: number;
  };
  byCategory: Record<string, CategorySummary>;
  byZone: Record<string, ZoneSummary>;
  byVatRate: Record<string, VatRateSummary>;
  byCountry: Record<string, { count: number; totalHT: number; totalTVA: number; totalTTC: number }>;
  transactions: CategorizedTransaction[];
  warnings: string[];
}

export interface CLIOptions {
  month: string; // YYYY-MM
  output: string;
  format: 'json' | 'csv' | 'both';
  saleType: SaleCategory;
  verbose: boolean;
  dryRun: boolean;
}
