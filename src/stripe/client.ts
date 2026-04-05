import Stripe from 'stripe';
import 'dotenv/config';

let stripeInstance: Stripe | null = null;

export function getStripe(): Stripe {
  if (!stripeInstance) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) {
      throw new Error('STRIPE_SECRET_KEY is not set. Copy .env.example to .env and add your key.');
    }
    stripeInstance = new Stripe(key, { apiVersion: '2025-02-24.acacia' });
  }
  return stripeInstance;
}

/**
 * Auto-paginate any Stripe list endpoint.
 * Yields all items across all pages.
 */
export async function* fetchAll<T extends { id: string }>(
  listFn: (params: Stripe.PaginationParams) => Stripe.ApiListPromise<T>,
  params: Record<string, unknown> = {},
  pageSize = 100,
): AsyncGenerator<T> {
  let hasMore = true;
  let startingAfter: string | undefined;

  while (hasMore) {
    const response = await listFn({
      limit: pageSize,
      starting_after: startingAfter,
      ...params,
    } as Stripe.PaginationParams);

    for (const item of response.data) {
      yield item;
    }

    hasMore = response.has_more;
    if (response.data.length > 0) {
      startingAfter = response.data[response.data.length - 1].id;
    }
  }
}
