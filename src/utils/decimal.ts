import Decimal from "decimal.js";

export { Decimal };

export function roundPrice(value: Decimal.Value, priceDecimals: number): Decimal {
  return new Decimal(value).toDecimalPlaces(priceDecimals, Decimal.ROUND_HALF_UP);
}

export function roundSize(value: Decimal.Value, sizeDecimals: number): Decimal {
  return new Decimal(value).toDecimalPlaces(sizeDecimals, Decimal.ROUND_DOWN);
}

export function isZero(value: Decimal.Value): boolean {
  return new Decimal(value).isZero();
}

export function abs(value: Decimal.Value): Decimal {
  return new Decimal(value).abs();
}

export function fmt(value: Decimal.Value, decimals?: number): string {
  const d = new Decimal(value);
  return decimals !== undefined ? d.toFixed(decimals) : d.toString();
}
