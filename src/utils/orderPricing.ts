import { Pool, PoolClient } from 'pg';
import {
  calculateOrderPricing,
  haversineKm,
  loadPricingRules,
  PricingRules,
} from './pricing';

export interface ResolvedCartItem {
  menuItemId: string;
  quantity: number;
  unitPrice: number;
  addonIds: string[];
  instructions?: string;
}

export interface PricingContext {
  subtotal: number;
  distanceKm: number;
  discount: number;
  loyaltyDiscount: number;
  rules: PricingRules;
}

export async function resolveCartSubtotal(
  client: Pool | PoolClient,
  restaurantId: string,
  items: Array<{ menuItemId: string; quantity: number; addonIds?: string[]; instructions?: string }>,
): Promise<{ subtotal: number; resolvedItems: ResolvedCartItem[] }> {
  let subtotal = 0;
  const resolvedItems: ResolvedCartItem[] = [];

  for (const item of items) {
    const itemRow = await client.query(
      'SELECT id, price FROM menu_items WHERE id=$1 AND restaurant_id=$2 AND is_available=true',
      [item.menuItemId, restaurantId],
    );
    if (!itemRow.rows.length) {
      throw new Error(`Menu item ${item.menuItemId} not found or unavailable.`);
    }

    let unitPrice = parseFloat(itemRow.rows[0].price);
    const addonIds = item.addonIds ?? [];

    if (addonIds.length) {
      const addonRows = await client.query('SELECT price FROM addons WHERE id = ANY($1)', [addonIds]);
      for (const a of addonRows.rows) unitPrice += parseFloat(a.price);
    }

    subtotal += unitPrice * item.quantity;
    resolvedItems.push({
      menuItemId: item.menuItemId,
      quantity: item.quantity,
      unitPrice,
      addonIds,
      instructions: item.instructions,
    });
  }

  return { subtotal: Math.round(subtotal * 100) / 100, resolvedItems };
}

export async function resolveDeliveryDistanceKm(
  client: Pool | PoolClient,
  options: {
    restaurantId: string;
    deliveryAddressId?: string;
    userId?: string;
    deliveryLatitude?: number;
    deliveryLongitude?: number;
    restaurantLatitude?: number;
    restaurantLongitude?: number;
  },
): Promise<number> {
  const parseCoord = (value: unknown): number | null => {
    if (value == null) return null;
    const n = parseFloat(String(value));
    return Number.isFinite(n) ? n : null;
  };

  const isValid = (lat: number | null, lng: number | null): boolean =>
    lat != null && lng != null && !(lat === 0 && lng === 0);

  let rLat = parseCoord(options.restaurantLatitude);
  let rLng = parseCoord(options.restaurantLongitude);
  let aLat = parseCoord(options.deliveryLatitude);
  let aLng = parseCoord(options.deliveryLongitude);

  const restRow = await client.query(
    'SELECT latitude, longitude FROM restaurants WHERE id=$1',
    [options.restaurantId],
  );
  if (restRow.rows.length && !isValid(rLat, rLng)) {
    rLat = parseCoord(restRow.rows[0].latitude);
    rLng = parseCoord(restRow.rows[0].longitude);
  }

  if (options.deliveryAddressId && options.userId) {
    const addrRow = await client.query(
      'SELECT latitude, longitude FROM user_addresses WHERE id=$1 AND user_id=$2',
      [options.deliveryAddressId, options.userId],
    );
    if (addrRow.rows.length && !isValid(aLat, aLng)) {
      aLat = parseCoord(addrRow.rows[0].latitude);
      aLng = parseCoord(addrRow.rows[0].longitude);
    }
  }

  if (!isValid(rLat, rLng) || !isValid(aLat, aLng)) return 0;

  return haversineKm(rLat!, rLng!, aLat!, aLng!);
}

export async function buildPricingContext(
  pool: Pool | PoolClient,
  params: {
    restaurantId: string;
    items: Array<{ menuItemId: string; quantity: number; addonIds?: string[] }>;
    deliveryAddressId?: string;
    userId?: string;
    couponCode?: string;
    loyaltyPointsToRedeem?: number;
    deliveryLatitude?: number;
    deliveryLongitude?: number;
    restaurantLatitude?: number;
    restaurantLongitude?: number;
  },
): Promise<PricingContext & { resolvedItems: ResolvedCartItem[] }> {
  const rules = await loadPricingRules(pool as Pool);
  const { subtotal, resolvedItems } = await resolveCartSubtotal(pool, params.restaurantId, params.items);

  const distanceKm = await resolveDeliveryDistanceKm(pool, {
    restaurantId: params.restaurantId,
    deliveryAddressId: params.deliveryAddressId,
    userId: params.userId,
    deliveryLatitude: params.deliveryLatitude,
    deliveryLongitude: params.deliveryLongitude,
    restaurantLatitude: params.restaurantLatitude,
    restaurantLongitude: params.restaurantLongitude,
  });

  let discount = 0;
  if (params.couponCode) {
    const couponRow = await pool.query(
      `SELECT discount_type, discount_value, max_discount, min_order, is_active, expires_at, max_uses, uses_count
       FROM coupons WHERE code = $1`,
      [params.couponCode.trim().toUpperCase()],
    );
    const c = couponRow.rows[0];
    if (
      c &&
      c.is_active &&
      (!c.expires_at || new Date(c.expires_at) >= new Date()) &&
      (c.max_uses === null || c.uses_count < c.max_uses) &&
      subtotal >= parseFloat(c.min_order)
    ) {
      discount =
        c.discount_type === 'percentage'
          ? Math.min(
              subtotal * (parseFloat(c.discount_value) / 100),
              c.max_discount ? parseFloat(c.max_discount) : Infinity,
            )
          : parseFloat(c.discount_value);
      discount = Math.round(discount * 100) / 100;
    }
  }

  let loyaltyDiscount = 0;
  const loyaltyPts =
    typeof params.loyaltyPointsToRedeem === 'number'
      ? Math.floor(params.loyaltyPointsToRedeem / 100) * 100
      : 0;

  if (loyaltyPts > 0 && params.userId) {
    const balRes = await pool.query(
      'SELECT loyalty_points_balance FROM users WHERE id=$1',
      [params.userId],
    );
    const balance: number = balRes.rows[0]?.loyalty_points_balance ?? 0;
    if (balance >= loyaltyPts) {
      loyaltyDiscount = (loyaltyPts / 100) * 10;
    }
  }

  return { subtotal, distanceKm, discount, loyaltyDiscount, rules, resolvedItems };
}

export async function quoteOrder(
  pool: Pool | PoolClient,
  params: Parameters<typeof buildPricingContext>[1],
) {
  const ctx = await buildPricingContext(pool, params);
  const pricing = calculateOrderPricing({
    subtotal: ctx.subtotal,
    distanceKm: ctx.distanceKm,
    discount: ctx.discount,
    loyaltyDiscount: ctx.loyaltyDiscount,
    rules: ctx.rules,
  });
  return { ...pricing, resolvedItems: ctx.resolvedItems };
}
