import { Cart, label, price, tax } from './pricing';

export const a = price(10, 2);
export const b = price(1 + 1, 3);
export const c = tax(5);
const cart = new Cart();
export const d = cart.total(4);
export const e = new Cart().total(3);
export const f = label('pen');
