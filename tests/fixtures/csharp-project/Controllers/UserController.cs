using System;
using System.Collections.Generic;
using MyApp.Models;
using MyApp.Services;

namespace MyApp.Controllers
{
    public class UserController
    {
        private readonly IUserService _userService;

        public UserController(IUserService userService)
        {
            _userService = userService;
        }

        public IList<User> Index()
        {
            return _userService.GetUsers();
        }

        public User? Show(int id)
        {
            return _userService.GetById(id);
        }

        public void Create(string name, string email)
        {
            var user = new User { Name = name, Email = email };
            _userService.AddUser(user);
            Console.WriteLine($"User {name} created.");
        }

        public void Delete(int id)
        {
            _userService.DeleteUser(id);
            Console.WriteLine($"User {id} deleted.");
        }
    }
}
