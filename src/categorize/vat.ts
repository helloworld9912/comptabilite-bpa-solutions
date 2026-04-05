import type { GeoZone } from '../types.js';
import { VAT_RATES } from '../config.js';

export interface VatResult {
  rate: number;
  exempt: boolean;
  exemptReason?: 'reverse_charge' | 'export' | 'legal_exemption';
}

/**
 * Determine VAT rate for a French seller.
 *
 * Rules:
 * - France B2B/B2C: French VAT (standard 20% by default)
 * - EU B2C (below OSS threshold): French VAT applies
 * - EU B2B (valid VAT number): Exempt (reverse charge / autoliquidation)
 * - Non-EU: Exempt (export)
 */
export function determineVat(
  zone: GeoZone,
  isB2B: boolean,
  vatRateOverride?: number,
): VatResult {
  // Non-EU: always exempt (export)
  if (zone === 'hors_ue') {
    return { rate: 0, exempt: true, exemptReason: 'export' };
  }

  // EU B2B with valid VAT number: reverse charge
  if (zone === 'ue' && isB2B) {
    return { rate: 0, exempt: true, exemptReason: 'reverse_charge' };
  }

  // France or EU B2C: French VAT applies
  const rate = vatRateOverride ?? VAT_RATES.standard;
  return { rate, exempt: false };
}

/**
 * Compute HT and TVA from TTC amount.
 * All amounts in cents to avoid floating point issues.
 */
export function splitTTC(amountTTC: number, vatRate: number): { amountHT: number; amountTVA: number } {
  if (vatRate === 0) {
    return { amountHT: amountTTC, amountTVA: 0 };
  }
  const amountHT = Math.round(amountTTC / (1 + vatRate));
  const amountTVA = amountTTC - amountHT;
  return { amountHT, amountTVA };
}
