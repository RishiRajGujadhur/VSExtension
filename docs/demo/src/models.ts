export interface Book {
  isbn: string;
  title: string;
  price: number;
  weight: number;
}

export interface LineItem {
  book: Book;
  quantity: number;
}

export interface Coupon {
  code: string;
  percentOff: number;
}

export interface Receipt {
  id: string;
  amount: number;
}

export abstract class PaymentMethod {
  abstract readonly name: string;

  abstract charge(amount: number): Promise<Receipt>;

  describe(): string {
    return `Pay with ${this.name}`;
  }
}

export class CardPayment extends PaymentMethod {
  readonly name = 'card';

  constructor(private readonly last4: string) {
    super();
  }

  async charge(amount: number): Promise<Receipt> {
    return { id: `card-${this.last4}`, amount };
  }

  describe(): string {
    return `${super.describe()} ending ${this.last4}`;
  }
}

export class GiftCardPayment extends PaymentMethod {
  readonly name = 'gift card';

  constructor(protected balance: number) {
    super();
  }

  async charge(amount: number): Promise<Receipt> {
    if (amount > this.balance) {
      throw new Error('Insufficient gift card balance');
    }
    this.balance -= amount;
    return { id: 'gift', amount };
  }
}

export class StoreCredit extends GiftCardPayment {
  async charge(amount: number): Promise<Receipt> {
    const receipt = await super.charge(amount);
    return { ...receipt, id: 'credit' };
  }
}
