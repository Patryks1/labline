import {
  blendApiPrice,
  splitBlendedApiPrice,
} from "../../../sim/balance/pricing";
import { modelOfferApiInOut, modelOfferApiPrice } from "../../../sim/systems/market";
import type { Model, ProductPricing } from "../../../sim/types";

/** Keep genuinely tiny API list prices legible without padding normal prices. */
export function formatApiListPrice(value: number): string {
  const price = Math.max(0, Number.isFinite(value) ? value : 0);
  if (price === 0) return "0";
  const decimals = price < 0.01 ? 7 : price < 1 ? 4 : 2;
  return price.toFixed(decimals).replace(/\.?0+$/, "");
}

/**
 * Convert any model list (token or native media units) into one comparable
 * $/MTok-equivalent peer quote. Scaling the in/out pair preserves its shape;
 * a native-only quote with no token blend falls back to the canonical split.
 */
export function effectiveApiPeerPricing(
  pricing: ProductPricing,
  model: Model,
): { price: number; priceIn: number; priceOut: number } {
  const token = modelOfferApiInOut(pricing, model);
  const price = modelOfferApiPrice(pricing, model);
  const tokenBlend = blendApiPrice(token.priceIn, token.priceOut);
  if (price <= 0) return { price: 0, priceIn: 0, priceOut: 0 };
  if (tokenBlend <= 0) {
    const split = splitBlendedApiPrice(price);
    return { price, priceIn: split.priceIn, priceOut: split.priceOut };
  }
  const scale = price / tokenBlend;
  return {
    price,
    priceIn: token.priceIn * scale,
    priceOut: token.priceOut * scale,
  };
}
