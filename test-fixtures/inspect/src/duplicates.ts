export function totalPrice(items: { price: number; qty: number }[]): number {
  let total = 0;
  for (const item of items) {
    total += item.price * item.qty;
  }
  return Math.round(total * 100) / 100;
}

export function totalWeight(parcels: { price: number; qty: number }[]): number {
  let sum = 0;
  for (const parcel of parcels) {
    sum += parcel.price * parcel.qty;
  }
  return Math.round(sum * 1000) / 1000;
}

export function different(values: number[]): number {
  let sum = 0;
  for (const value of values) {
    sum -= value;
  }
  return sum;
}
