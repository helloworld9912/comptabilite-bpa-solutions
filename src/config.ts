import type { GeoZone, SaleCategory } from './types.js';

// BPA SOLUTIONS - début d'activité effective = premier encaissement Qonto
// Immatriculation INPI: 17/06/2025 (création juridique)
// Début d'exploitation: 29/07/2025 (premier payout sur compte société Qonto)
// Les charges avant cette date restent sur l'auto-entreprise
export const BPA_SOLUTIONS_START = new Date('2025-07-29T00:00:00Z');
export const BPA_SOLUTIONS_START_UNIX = Math.floor(BPA_SOLUTIONS_START.getTime() / 1000);
export const FISCAL_YEAR_END = new Date('2026-03-31T23:59:59Z');
export const FISCAL_YEAR_END_UNIX = Math.floor(FISCAL_YEAR_END.getTime() / 1000);

// Compte bancaire Qonto (société BPA SOLUTIONS)
// Les payouts vers ce compte apparaissent sur le relevé bancaire Qonto
export const QONTO_BANK_ACCOUNT_ID = 'ba_1RqqHtBsJM7cX1Yeu7G1KP3z';

// 27 EU member states (ISO 3166-1 alpha-2)
export const EU_COUNTRIES = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR',
  'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL',
  'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
]);

export const COUNTRY_NAMES: Record<string, string> = {
  AT: 'Autriche', BE: 'Belgique', BG: 'Bulgarie', HR: 'Croatie',
  CY: 'Chypre', CZ: 'Tchéquie', DK: 'Danemark', EE: 'Estonie',
  FI: 'Finlande', FR: 'France', DE: 'Allemagne', GR: 'Grèce',
  HU: 'Hongrie', IE: 'Irlande', IT: 'Italie', LV: 'Lettonie',
  LT: 'Lituanie', LU: 'Luxembourg', MT: 'Malte', NL: 'Pays-Bas',
  PL: 'Pologne', PT: 'Portugal', RO: 'Roumanie', SK: 'Slovaquie',
  SI: 'Slovénie', ES: 'Espagne', SE: 'Suède',
  GB: 'Royaume-Uni', US: 'États-Unis', CA: 'Canada', CH: 'Suisse',
  AU: 'Australie', JP: 'Japon', CN: 'Chine', BR: 'Brésil',
  IN: 'Inde', MX: 'Mexique', KR: 'Corée du Sud', SG: 'Singapour',
  HK: 'Hong Kong', NO: 'Norvège', NZ: 'Nouvelle-Zélande',
  MA: 'Maroc', TN: 'Tunisie', SN: 'Sénégal', CI: "Côte d'Ivoire",
};

export const VAT_RATES = {
  standard: 0.20,
  intermediate: 0.10,
  reduced: 0.055,
  zero: 0,
} as const;

export const MONTH_NAMES_FR = [
  'Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin',
  'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre',
];

// Plan Comptable Général accounts
interface PCGMapping {
  account: string;
  label: string;
}

const PCG: Record<string, PCGMapping> = {
  // Ventes de marchandises
  'marchandises_france': { account: '707100', label: 'Ventes de marchandises - France' },
  'marchandises_ue': { account: '707200', label: 'Ventes de marchandises - UE' },
  'marchandises_hors_ue': { account: '707300', label: 'Ventes de marchandises - Export' },
  // Ventes de produits finis
  'produits_finis_france': { account: '701100', label: 'Ventes de produits finis - France' },
  'produits_finis_ue': { account: '701200', label: 'Ventes de produits finis - UE' },
  'produits_finis_hors_ue': { account: '701300', label: 'Ventes de produits finis - Export' },
  // Prestations de services
  'services_france': { account: '706100', label: 'Prestations de services - France' },
  'services_ue': { account: '706200', label: 'Prestations de services - UE' },
  'services_hors_ue': { account: '706300', label: 'Prestations de services - Export' },
  // Fees
  'commission_stripe': { account: '622600', label: 'Commissions Stripe' },
  'frais_bancaires': { account: '627100', label: 'Frais bancaires divers' },
  // Refunds
  'refund': { account: '709000', label: 'Rabais, remises et ristournes accordés' },
};

export function getPCGMapping(category: SaleCategory, zone: GeoZone): PCGMapping {
  const key = `${category}_${zone}`;
  return PCG[key] ?? { account: '707000', label: 'Ventes de marchandises' };
}

export function getFeePCGMapping(feeType: 'stripe' | 'application' | 'other'): PCGMapping {
  if (feeType === 'stripe' || feeType === 'application') {
    return PCG['commission_stripe'];
  }
  return PCG['frais_bancaires'];
}

export function getRefundPCGMapping(): PCGMapping {
  return PCG['refund'];
}

export function getCountryName(code: string): string {
  return COUNTRY_NAMES[code.toUpperCase()] ?? code;
}
