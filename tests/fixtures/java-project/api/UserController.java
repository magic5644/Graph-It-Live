package com.example.myapp.api; // NOSONAR - test fixture, directory does not match package

import com.example.myapp.UserService;
import com.example.myapp.models.User;

import java.util.List;
import java.util.Optional;
import java.util.logging.Level;
import java.util.logging.Logger;

public class UserController {
    private static final Logger LOGGER = Logger.getLogger(UserController.class.getName());

    private final UserService userService;

    public UserController() {
        this.userService = new UserService();
    }

    public List<User> listUsers() {
        LOGGER.info("GET /users");
        return userService.getAllUsers();
    }

    public Optional<User> getUser(int id) {
        LOGGER.log(Level.INFO, "GET /users/{0}", id);
        return userService.getUserById(id);
    }

    public void createUser(String name, String email) {
        LOGGER.log(Level.INFO, "POST /users name={0}", name);
        userService.createUser(name, email);
    }

    public boolean deleteUser(int id) {
        LOGGER.log(Level.INFO, "DELETE /users/{0}", id);
        return userService.deleteUser(id);
    }
}
