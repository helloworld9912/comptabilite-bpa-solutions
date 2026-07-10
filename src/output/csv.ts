import { stringify } from 'csv-stringify/sync';
import type { MonthlyReport, CategorizedTransaction } from '../types.js';
import { centsToEur } from './report.js';
import { getCountryName } from '../config.js';

/**
 * Generate a detailed CSV with one row per transaction.
 */
export function generateTransactionsCsv(report: MonthlyReport): string {
  const rows = report.transactions.map(t => ({
    'Date': t.date.split('T')[0],
    'Type': typeLabel(t.type),
    'ID Stripe': t.stripeChargeId,
    'Client': t.stripeCustomerName ?? '',
    'Email': t.stripeCustomerEmail ?? '',
    'Pays': getCountryName(t.country),
    'Code Pays': t.country,
    'Zone': zoneLabel(t.zone),
    'B2B': t.isB2B ? 'Oui' : 'Non',
    'N° TVA': t.isB2B ? 'Oui' : '',
    'Exonéré': t.vatExempt ? 'Oui' : 'Non',
    'Raison exonération': t.vatExemptReason ?? '',
    'Catégorie': categoryLabel(t.saleCategory),
    'Compte PCG': t.pcgAccount,
    'Libellé PCG': t.pcgLabel,
    'Montant TTC (EUR)': centsToEur(t.amountTTC),
    'Montant HT (EUR)': centsToEur(t.amountHT),
    'TVA (EUR)': centsToEur(t.amountTVA),
    'Taux TVA': `${(t.vatRate * 100).toFixed(1)}%`,
    'Devise originale': t.originalCurrency,
    'Montant original': centsToEur(t.originalAmount),
    'Taux de change': t.exchangeRate?.toFixed(6) ?? '',
    'Frais Stripe (EUR)': centsToEur(t.stripeFee),
    'Net (EUR)': centsToEur(t.netAmount),
    'Produit': t.productName ?? '',
    'Description': t.description,
    'URL Reçu': t.receiptUrl ?? '',
    'URL Facture PDF': t.invoicePdfUrl ?? '',
  }));

  return stringify(rows, {
    header: true,
    delimiter: ';', // French Excel default
    bom: true, // BOM for Excel UTF-8
  });
}

/**
 * Generate a summary CSV grouped by PCG account (for Indy import).
 */
export function generateSummaryCsv(report: MonthlyReport): string {
  const rows: Record<string, string>[] = [];

  // Sales by account
  for (const [, cat] of Object.entries(report.byCategory)) {
    rows.push({
      'Date': report.period.startDate,
      'Libellé': `${cat.label} - ${report.period.label}`,
      'Compte': cat.pcgAccount,
      'Débit': '',
      'Crédit': centsToEur(cat.totalTTC),
      'TVA collectée': centsToEur(cat.totalTVA),
      'HT': centsToEur(cat.totalHT),
      'Nombre opérations': String(cat.count),
    });
  }

  // Stripe fees
  if (report.summary.fees.totalFees > 0) {
    rows.push({
      'Date': report.period.startDate,
      'Libellé': `Commissions Stripe - ${report.period.label}`,
      'Compte': '622600',
      'Débit': centsToEur(report.summary.fees.totalFees),
      'Crédit': '',
      'TVA collectée': '',
      'HT': centsToEur(report.summary.fees.totalFees),
      'Nombre opérations': '',
    });
  }

  return stringify(rows, {
    header: true,
    delimiter: ';',
    bom: true,
  });
}

/**
 * Generate a CSV by country for VAT reporting.
 */
export function generateCountryCsv(report: MonthlyReport): string {
  const rows = Object.entries(report.byCountry)
    .sort(([, a], [, b]) => b.totalTTC - a.totalTTC)
    .map(([code, data]) => ({
      'Pays': getCountryName(code),
      'Code': code,
      'Zone': zoneLabel(code === 'FR' ? 'france' : code),
      'Nombre': String(data.count),
      'Total HT (EUR)': centsToEur(data.totalHT),
      'TVA (EUR)': centsToEur(data.totalTVA),
      'Total TTC (EUR)': centsToEur(data.totalTTC),
    }));

  return stringify(rows, {
    header: true,
    delimiter: ';',
    bom: true,
  });
}

function typeLabel(type: string): string {
  const labels: Record<string, string> = {
    sale: 'Vente',
    refund: 'Remboursement',
    dispute: 'Litige',
    fee: 'Commission',
    payout: 'Virement',
    adjustment: 'Ajustement',
  };
  return labels[type] ?? type;
}

function zoneLabel(zone: string): string {
  const labels: Record<string, string> = {
    france: 'France',
    ue: 'Union Européenne',
    hors_ue: 'Hors UE',
  };
  return labels[zone] ?? zone;
}

function categoryLabel(cat: string): string {
  const labels: Record<string, string> = {
    marchandises: 'Ventes de marchandises',
    produits_finis: 'Ventes de produits finis',
    services: 'Prestations de services',
  };
  return labels[cat] ?? cat;
}
