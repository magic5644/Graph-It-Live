using System.Collections.Generic;
using MyApp.Infrastructure;
using MyApp.Models;

namespace MyApp.Services
{
    public class ProductService
    {
        private readonly Database _db;

        public ProductService()
        {
            _db = new Database();
        }

        public IList<Product> GetProducts()
        {
            return _db.Query<Product>("SELECT * FROM Products");
        }

        public IList<Product> GetInStock()
        {
            return _db.Query<Product>("SELECT * FROM Products WHERE Stock > 0");
        }

        public Order PlaceOrder(User customer, IList<Product> items)
        {
            var order = new Order { Customer = customer };
            foreach (var item in items)
            {
                order.Items.Add(item);
            }
            _db.Execute($"INSERT INTO Orders (CustomerId) VALUES ({customer.Id})");
            return order;
        }
    }
}
