import type { LineItem } from './models';

export function parcelWeight(parcels: LineItem[]): number {
  let sum = 0;
  for (const parcel of parcels) {
    sum += parcel.book.weight * parcel.quantity;
  }
  return Math.round(sum * 1000) / 1000;
}

export function shippingCost(items: LineItem[]): number {
  const weight = parcelWeight(items);
  return weight > 2 ? 7.5 : 3.5;
}
