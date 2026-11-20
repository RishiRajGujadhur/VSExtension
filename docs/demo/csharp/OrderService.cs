using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading.Tasks;

namespace Bookshop.Orders
{
    public interface IPriced
    {
        decimal Price();
    }

    public record LineItem(string Title, decimal UnitPrice, int Quantity, bool Free);

    public class Cart : IPriced
    {
        private readonly List<LineItem> items = new();
        private decimal total;

        public int Count => items.Count;

        public decimal Discount { get; set; }

        public void Add(LineItem item)
        {
            if (item.Quantity <= 0)
            {
                throw new ArgumentException("Quantity must be positive", nameof(item));
            }
            items.Add(item);
        }

        public decimal Price()
        {
            total = 0;
            foreach (var item in items)
            {
                if (item.Free) continue;
                total += item.UnitPrice * item.Quantity;
            }
            if (Discount > 0)
            {
                total -= total * Discount;
            }
            return Math.Round(total, 2);
        }
    }

    public class OrderService
    {
        private readonly Cart cart;
        private int attempts;

        public OrderService(Cart cart)
        {
            this.cart = cart;
        }

        public string Grade(decimal amount)
        {
            switch (amount)
            {
                case 0:
                    return "empty";
                case < 20:
                    return "small";
                case >= 20 and < 100 when cart.Count > 3:
                    return "many small things";
                case >= 100:
                    return "large";
                default:
                    break;
            }
            return "medium";
        }

        public async Task<decimal> PlaceOrderAsync(string customer, string? coupon)
        {
            if (string.IsNullOrWhiteSpace(customer))
            {
                throw new ArgumentException("A customer is needed", nameof(customer));
            }
            var amount = cart.Price();
            if (coupon != null && coupon.StartsWith("SAVE"))
            {
                amount *= 0.9m;
            }
            while (attempts < 3)
            {
                attempts++;
                try
                {
                    await SaveAsync(customer, amount);
                    break;
                }
                catch (IOException e) when (attempts < 3)
                {
                    Log($"retry {attempts}: {e.Message}");
                }
                catch (Exception ex)
                {
                    Log(ex.Message);
                    throw ex;
                }
                finally
                {
                    Log("attempt done");
                }
            }
            return amount;
        }

        public decimal TotalOf(IEnumerable<LineItem> lines)
        {
            Func<LineItem, decimal> lineTotal = line =>
            {
                if (line.Free) return 0;
                return line.UnitPrice * line.Quantity;
            };
            return lines.Sum(lineTotal);
        }

        // Deliberate slips for the inspections.
        public async void Refresh()
        {
            await Task.Delay(10);
            attempts = attempts;
            if (attempts == attempts) { Log("always"); }
            try { Log("refresh"); } catch { }
        }

        private Task SaveAsync(string customer, decimal amount) => Task.Delay(1);

        private static void Log(string message) => Console.WriteLine(message);
    }
}
