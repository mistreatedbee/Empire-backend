import { Pool } from 'pg';

export interface PricingRules {
  baseFee: number;
  includedKm: number;
  midKmRate: number;
  midKmUntil: number;
  longKmRate: number;
  serviceFeePct: number;
  smallOrderThreshold: number;
  smallOrderFee: number;
  peakMultiplier: number;
  driverSharePct: number;
}

export const DEFAULT_PRICING_RULES: PricingRules = {
  baseFee: 20,
  includedKm: 3,
  midKmRate: 5,
  midKmUntil: 7,
  longKmRate: 7,
  serviceFeePct: 0.05,
  smallOrderThreshold: 100,
  smallOrderFee: 10,
  peakMultiplier: 1,
  driverSharePct: 0.75,
};

export interface DeliveryFeeBreakdown {
  baseFee: number;
  distanceKm: number;
  distanceCharge: number;
  peakMultiplier: number;
  peakAmount: number;
  deliveryFee: number;
}

export interface OrderPricingInput {
  subtotal: number;
  distanceKm: number;
  discount?: number;
  loyaltyDiscount?: number;
  rules?: PricingRules;
}

export interface OrderPricingResult {
  subtotal: number;
  deliveryFee: number;
  serviceFee: number;
  smallOrderFee: number;
  discount: number;
  loyaltyDiscount: number;
  total: number;
  distanceKm: number;
  estimatedDeliveryMinutes: number;
  breakdown: DeliveryFeeBreakdown & {
    serviceFeePct: number;
    smallOrderApplied: boolean;
  };
  driverPayout: number;
  platformDeliveryRetain: number;
}

export function haversineKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function deliveryFeeFromDistance(
  distanceKm: number,
  rules: PricingRules,
): DeliveryFeeBreakdown {
  const km = Math.max(0, distanceKm);
  const baseFee = rules.baseFee;
  let distanceCharge = 0;

  if (km > rules.includedKm) {
    const midEnd = Math.min(km, rules.midKmUntil);
    const midKm = Math.max(0, midEnd - rules.includedKm);
    distanceCharge += midKm * rules.midKmRate;

    if (km > rules.midKmUntil) {
      distanceCharge += (km - rules.midKmUntil) * rules.longKmRate;
    }
  }

  const prePeak = baseFee + distanceCharge;
  const peakMultiplier = rules.peakMultiplier > 1 ? rules.peakMultiplier : 1;
  const deliveryFee = Math.round(prePeak * peakMultiplier * 100) / 100;
  const peakAmount = Math.round((deliveryFee - prePeak) * 100) / 100;

  return {
    baseFee,
    distanceKm: Math.round(km * 10) / 10,
    distanceCharge: Math.round(distanceCharge * 100) / 100,
    peakMultiplier,
    peakAmount,
    deliveryFee,
  };
}

export function calculateOrderPricing(input: OrderPricingInput): OrderPricingResult {
  const rules = input.rules ?? DEFAULT_PRICING_RULES;
  const subtotal = Math.max(0, input.subtotal);
  const discount = Math.max(0, input.discount ?? 0);
  const loyaltyDiscount = Math.max(0, input.loyaltyDiscount ?? 0);

  const delivery = deliveryFeeFromDistance(input.distanceKm, rules);
  const serviceFee = Math.round(subtotal * rules.serviceFeePct * 100) / 100;
  const smallOrderApplied = subtotal > 0 && subtotal < rules.smallOrderThreshold;
  const smallOrderFee = smallOrderApplied ? rules.smallOrderFee : 0;

  const total = Math.max(
    0,
    Math.round((subtotal + delivery.deliveryFee + serviceFee + smallOrderFee - discount - loyaltyDiscount) * 100) / 100,
  );

  const driverPayout = Math.round(delivery.deliveryFee * rules.driverSharePct * 100) / 100;
  const platformDeliveryRetain = Math.round((delivery.deliveryFee - driverPayout) * 100) / 100;

  const estimatedDeliveryMinutes = Math.round(25 + input.distanceKm * 3);

  return {
    subtotal,
    deliveryFee: delivery.deliveryFee,
    serviceFee,
    smallOrderFee,
    discount,
    loyaltyDiscount,
    total,
    distanceKm: delivery.distanceKm,
    estimatedDeliveryMinutes,
    breakdown: {
      ...delivery,
      serviceFeePct: rules.serviceFeePct,
      smallOrderApplied,
    },
    driverPayout,
    platformDeliveryRetain,
  };
}

export async function loadPricingRules(pool: Pool): Promise<PricingRules> {
  try {
    const { rows } = await pool.query(
      `SELECT base_fee, included_km, mid_km_rate, mid_km_until, long_km_rate,
              service_fee_pct, small_order_threshold, small_order_fee,
              peak_multiplier, driver_share_pct
       FROM pricing_rules WHERE is_active = true
       ORDER BY updated_at DESC LIMIT 1`,
    );
    if (!rows.length) return DEFAULT_PRICING_RULES;
    const r = rows[0];
    return {
      baseFee: parseFloat(String(r.base_fee)),
      includedKm: parseFloat(String(r.included_km)),
      midKmRate: parseFloat(String(r.mid_km_rate)),
      midKmUntil: parseFloat(String(r.mid_km_until)),
      longKmRate: parseFloat(String(r.long_km_rate)),
      serviceFeePct: parseFloat(String(r.service_fee_pct)),
      smallOrderThreshold: parseFloat(String(r.small_order_threshold)),
      smallOrderFee: parseFloat(String(r.small_order_fee)),
      peakMultiplier: parseFloat(String(r.peak_multiplier)),
      driverSharePct: parseFloat(String(r.driver_share_pct)),
    };
  } catch {
    return DEFAULT_PRICING_RULES;
  }
}
