using System;
using System.Collections.Generic;
using MyApp.Services;
using MyApp.Models;

namespace MyApp
{
    class Program
    {
        static void Main(string[] args)
        {
            var service = new UserService();
            var users = service.GetUsers();
            Console.WriteLine($"Found {users.Count} users");
        }
    }
}
