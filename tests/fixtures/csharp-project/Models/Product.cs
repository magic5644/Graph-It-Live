using System.Collections.Generic;
using MyApp.Models;

namespace MyApp.Models
{
    public class Product
    {
        public int Id { get; set; }
        public string Name { get; set; } = string.Empty;
        public decimal Price { get; set; }
        public int Stock { get; set; }
    }

    public class Order
    {
        public int Id { get; set; }
        public User Customer { get; set; } = new User();
        public ICollection<Product> Items { get; set; } = new List<Product>();
        public decimal Total => 0m;
    }
}
