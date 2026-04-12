using System.Collections.Generic;
using System.Linq;
using MyApp.Infrastructure;
using MyApp.Models;

namespace MyApp.Services
{
    public class UserService : IUserService
    {
        private readonly Database _db;

        public UserService()
        {
            _db = new Database();
        }

        public IList<User> GetUsers()
        {
            return _db.Query<User>("SELECT * FROM Users");
        }

        public User? GetById(int id)
        {
            return _db.Query<User>($"SELECT * FROM Users WHERE Id = {id}").FirstOrDefault();
        }

        public void AddUser(User user)
        {
            _db.Execute($"INSERT INTO Users (Name, Email) VALUES ('{user.Name}', '{user.Email}')");
        }

        public void DeleteUser(int id)
        {
            _db.Execute($"DELETE FROM Users WHERE Id = {id}");
        }
    }
}
