import type { GeoZone } from '../types.js';
import { EU_COUNTRIES } from '../config.js';

export function classifyZone(countryCode: string): GeoZone {
  const code = countryCode.toUpperCase();
  if (code === 'FR') return 'france';
  if (EU_COUNTRIES.has(code)) return 'ue';
  return 'hors_ue';
}
