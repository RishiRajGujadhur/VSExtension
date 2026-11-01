import { addToCart, cartFor, CardPayment, formatPrice, subtotal } from './index';
import { placeOrder, quickReorder } from './orders';
import { parseBook } from './api';
import { currencyOrDefault } from './config';
import { formatTitle } from './format';

const book = parseBook('{"isbn":"978-0","title":"Refactoring","price":42,"weight":0.9}');
const items = cartFor('ann');
addToCart(items, book, 2);
console.log(formatTitle(book.title), formatPrice(subtotal(items)), currencyOrDefault('{}'));

await placeOrder('order-1', items, new CardPayment('4242'), 'READ10');
quickReorder('order-2', items, new CardPayment('4242'));
