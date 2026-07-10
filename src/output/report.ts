import type {
  CategorizedTransaction,
  MonthlyReport,
  CategorySummary,
  ZoneSummary,
  VatRateSummary,
  GeoZone,
  B2BreakDown,
  OssBreakdown,
} from '../types.js';
import { MONTH_NAMES_FR, getCountryName } from '../config.js';

const ZONE_LABELS: Record<GeoZone, string> = {
  france: 'France',
  ue: 'Union Européenne',
  hors_ue: 'Hors Union Européenne',
};

/**
 * Build a complete monthly report from categorized transactions.
 */
export function buildReport(
  year: number,
  month: number,
  transactions: CategorizedTransaction[],
  warnings: string[],
): MonthlyReport {
  const sales = transactions.filter(t => t.type === 'sale');
  const refunds = transactions.filter(t => t.type === 'refund');
  const disputes = transactions.filter(t => t.type === 'dispute');
  const refundsAndDisputes = [...refunds, ...disputes];

  // Summary
  const totalSalesHT = sum(sales, t => t.amountHT);
  const totalTVA = sum(sales, t => t.amountTVA);
  const totalSalesTTC = sum(sales, t => t.amountTTC);
  const totalRefundsHT = sum(refundsAndDisputes, t => t.amountHT);
  const totalRefundsTVA = sum(refundsAndDisputes, t => t.amountTVA);
  const totalRefundsTTC = sum(refundsAndDisputes, t => t.amountTTC);
  const totalStripeFees = sum(sales, t => t.stripeFee);
  const totalAppFees = sum(sales, t => t.applicationFee);

  // By category (PCG account) — inclut les remboursements/litiges (compte 709000)
  // car c'est la vue "écritures comptables" (comme Dougs). Les ventilations
  // zone/TVA/pays/OSS ci-dessous sont en VENTES BRUTES (remboursements ventilés à part).
  const byCategory: Record<string, CategorySummary> = {};
  for (const t of [...sales, ...refundsAndDisputes]) {
    const key = t.pcgAccount;
    if (!byCategory[key]) {
      byCategory[key] = {
        label: t.pcgLabel,
        pcgAccount: t.pcgAccount,
        count: 0,
        totalHT: 0,
        totalTVA: 0,
        totalTTC: 0,
      };
    }
    byCategory[key].count++;
    byCategory[key].totalHT += t.amountHT;
    byCategory[key].totalTVA += t.amountTVA;
    byCategory[key].totalTTC += t.amountTTC;
  }

  // By zone (with B2B / B2C breakdown) — ventes brutes seules
  const byZone: Record<string, ZoneSummary> = {};
  for (const t of sales) {
    if (!byZone[t.zone]) {
      byZone[t.zone] = {
        zone: t.zone,
        label: ZONE_LABELS[t.zone],
        count: 0,
        totalHT: 0,
        totalTVA: 0,
        totalTTC: 0,
        countries: {},
        b2b: emptyBreakdown(),
        b2c: emptyBreakdown(),
      };
    }
    const z = byZone[t.zone];
    z.count++;
    z.totalHT += t.amountHT;
    z.totalTVA += t.amountTVA;
    z.totalTTC += t.amountTTC;
    addToBreakdown(t.isB2B ? z.b2b : z.b2c, t);
    if (!z.countries[t.country]) {
      z.countries[t.country] = { count: 0, totalTTC: 0 };
    }
    z.countries[t.country].count++;
    z.countries[t.country].totalTTC += t.amountTTC;
  }

  // By VAT rate (with B2B / B2C breakdown + exempt reason breakdown) — ventes brutes seules
  const byVatRate: Record<string, VatRateSummary> = {};
  for (const t of sales) {
    const key = `${t.vatRate}`;
    if (!byVatRate[key]) {
      byVatRate[key] = {
        rate: t.vatRate,
        label: t.vatRate === 0
          ? 'Exonéré (0%)'
          : `TVA ${(t.vatRate * 100).toFixed(1)}%`,
        count: 0,
        totalHT: 0,
        totalTVA: 0,
        totalTTC: 0,
        b2b: emptyBreakdown(),
        b2c: emptyBreakdown(),
        ...(t.vatRate === 0 ? { exemptByReason: { reverseCharge: emptyBreakdown(), export: emptyBreakdown() } } : {}),
      };
    }
    const v = byVatRate[key];
    v.count++;
    v.totalHT += t.amountHT;
    v.totalTVA += t.amountTVA;
    v.totalTTC += t.amountTTC;
    addToBreakdown(t.isB2B ? v.b2b : v.b2c, t);
    // Exempt reason breakdown (only for rate=0)
    if (v.exemptByReason && t.vatExempt) {
      if (t.vatExemptReason === 'reverse_charge') {
        addToBreakdown(v.exemptByReason.reverseCharge, t);
      } else if (t.vatExemptReason === 'export') {
        addToBreakdown(v.exemptByReason.export, t);
      }
    }
  }

  // OSS breakdown: EU B2C sales (ventes à particuliers UE hors France)
  const oss: OssBreakdown = {
    totalCount: 0,
    totalHT: 0,
    totalTVA: 0,
    totalTTC: 0,
    byCountry: {},
  };
  for (const t of sales) {
    if (t.zone === 'ue' && !t.isB2B) {
      oss.totalCount++;
      oss.totalHT += t.amountHT;
      oss.totalTVA += t.amountTVA;
      oss.totalTTC += t.amountTTC;
      if (!oss.byCountry[t.country]) {
        oss.byCountry[t.country] = {
          count: 0,
          vatRate: t.vatRate,
          totalHT: 0,
          totalTVA: 0,
          totalTTC: 0,
        };
      }
      const c = oss.byCountry[t.country];
      c.count++;
      c.totalHT += t.amountHT;
      c.totalTVA += t.amountTVA;
      c.totalTTC += t.amountTTC;
    }
  }

  // By country — ventes brutes seules (remboursements/litiges ventilés à part)
  const byCountry: Record<string, { count: number; totalHT: number; totalTVA: number; totalTTC: number }> = {};
  for (const t of sales) {
    if (!byCountry[t.country]) {
      byCountry[t.country] = { count: 0, totalHT: 0, totalTVA: 0, totalTTC: 0 };
    }
    byCountry[t.country].count++;
    byCountry[t.country].totalHT += t.amountHT;
    byCountry[t.country].totalTVA += t.amountTVA;
    byCountry[t.country].totalTTC += t.amountTTC;
  }

  return {
    period: {
      year,
      month,
      label: `${MONTH_NAMES_FR[month - 1]} ${year}`,
      startDate: `${year}-${String(month).padStart(2, '0')}-01`,
      endDate: `${year}-${String(month).padStart(2, '0')}-${new Date(year, month, 0).getDate()}`,
    },
    generatedAt: new Date().toISOString(),
    currency: 'EUR',
    summary: {
      totalSalesHT,
      totalTVA,
      totalSalesTTC,
      totalRefundsHT,
      totalRefundsTVA,
      totalRefundsTTC,
      fees: {
        stripeFees: totalStripeFees,
        applicationFees: totalAppFees,
        totalFees: totalStripeFees + totalAppFees,
      },
      netRevenue: totalSalesTTC + totalRefundsTTC - totalStripeFees - totalAppFees,
    },
    byCategory,
    byZone,
    byVatRate,
    byCountry,
    oss,
    transactions,
    warnings,
  };
}

function emptyBreakdown(): B2BreakDown {
  return { count: 0, totalHT: 0, totalTVA: 0, totalTTC: 0 };
}

function addToBreakdown(b: B2BreakDown, t: CategorizedTransaction): void {
  b.count++;
  b.totalHT += t.amountHT;
  b.totalTVA += t.amountTVA;
  b.totalTTC += t.amountTTC;
}

/**
 * Format cents to EUR string for display.
 */
export function centsToEur(cents: number): string {
  return (cents / 100).toFixed(2);
}

function sum(items: CategorizedTransaction[], fn: (t: CategorizedTransaction) => number): number {
  return items.reduce((acc, t) => acc + fn(t), 0);
}
