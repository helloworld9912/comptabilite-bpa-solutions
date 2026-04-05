import type Stripe from 'stripe';
import type { CustomerInfo } from '../types.js';
import { getStripe } from './client.js';

const cache = new Map<string, CustomerInfo>();

/**
 * Resolve customer info with country and VAT status.
 * Priority: tax_ids > address.country > billing_details > card country
 */
export async function resolveCustomer(
  customerId: string | null | undefined,
  charge: Stripe.Charge,
): Promise<CustomerInfo> {
  if (customerId && cache.has(customerId)) {
    return cache.get(customerId)!;
  }

  const stripe = getStripe();
  let customer: Stripe.Customer | null = null;
  let country = '';
  let vatId: string | undefined;
  let isB2B = false;
  let name: string | undefined;
  let email: string | undefined;

  // Try to get full customer object
  if (customerId) {
    try {
      const raw = await stripe.customers.retrieve(customerId, {
        expand: ['tax_ids'],
      });
      if (!('deleted' in raw) || !raw.deleted) {
        customer = raw as Stripe.Customer;
      }
    } catch {
      // Customer may have been deleted
    }
  }

  if (customer) {
    name = customer.name ?? undefined;
    email = customer.email ?? undefined;

    // Check tax IDs for VAT number (highest priority for country + B2B)
    const taxIds = customer.tax_ids;
    if (taxIds && 'data' in taxIds && taxIds.data.length > 0) {
      const euVat = taxIds.data.find(t =>
        t.type === 'eu_vat' && t.verification?.status === 'verified'
      );
      if (euVat) {
        vatId = euVat.value;
        isB2B = true;
        // EU VAT numbers start with country code (e.g., DE123456789)
        country = euVat.value.substring(0, 2).toUpperCase();
      }
    }

    // Customer address country
    if (!country && customer.address?.country) {
      country = customer.address.country.toUpperCase();
    }

    // Shipping address country
    if (!country && customer.shipping?.address?.country) {
      country = customer.shipping.address.country.toUpperCase();
    }
  }

  // Billing details from charge
  if (!country && charge.billing_details?.address?.country) {
    country = charge.billing_details.address.country.toUpperCase();
  }

  // Name/email from charge
  if (!name && charge.billing_details?.name) {
    name = charge.billing_details.name;
  }
  if (!email && charge.billing_details?.email) {
    email = charge.billing_details.email;
  }

  // Card country as last resort
  if (!country) {
    const card = charge.payment_method_details?.card;
    if (card?.country) {
      country = card.country.toUpperCase();
    }
  }

  // Default to FR if nothing found
  if (!country) {
    country = 'UNKNOWN';
  }

  const info: CustomerInfo = {
    customerId: customerId ?? 'guest',
    country,
    vatId,
    isB2B,
    name,
    email,
  };

  if (customerId) {
    cache.set(customerId, info);
  }

  return info;
}

export function clearCustomerCache(): void {
  cache.clear();
}
