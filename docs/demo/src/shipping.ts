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

export type Speed = 'standard' | 'express' | 'overnight';

export function deliveryDays(items: LineItem[], speed: Speed, remote: boolean): number {
  if (items.length === 0) {
    return 0;
  }
  let days = 5;
  switch (speed) {
    case 'express':
      days = 2;
      break;
    case 'overnight':
      if (remote) {
        days = 2;
      } else {
        days = 1;
      }
      break;
    default:
      if (parcelWeight(items) > 20) {
        days += 2;
      }
  }
  return days;
}
