using System.Collections.Generic;
using MyApp.Models;

namespace MyApp.Services
{
    public interface IUserService
    {
        IList<User> GetUsers();
        User? GetById(int id);
        void AddUser(User user);
        void DeleteUser(int id);
    }
}
