using System;
using System.Collections.Generic;

namespace MyApp.Models
{
    public class User
    {
        public int Id { get; set; }
        public string Name { get; set; } = string.Empty;
        public string Email { get; set; } = string.Empty;
        public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
        public ICollection<Order> Orders { get; set; } = new List<Order>();
    }
}
