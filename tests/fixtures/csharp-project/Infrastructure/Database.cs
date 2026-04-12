using System;
using System.Collections.Generic;
using System.Data;
using MyApp.Models;

namespace MyApp.Infrastructure
{
    public class Database
    {
        private readonly string _connectionString;

        public Database(string connectionString = "Data Source=app.db")
        {
            _connectionString = connectionString;
        }

        public IList<T> Query<T>(string sql) where T : new()
        {
            Console.WriteLine($"[DB] Query: {sql}");
            return new List<T>();
        }

        public void Execute(string sql)
        {
            Console.WriteLine($"[DB] Execute: {sql}");
        }
    }
}
