package com.example.myapp; // NOSONAR - test fixture, directory structure differs from package

import java.util.List;
import java.util.ArrayList;
import java.util.logging.Level;
import java.util.logging.Logger;
import com.example.myapp.UserService;
import com.example.myapp.models.User;

public class Main {
    private static final Logger LOGGER = Logger.getLogger(Main.class.getName());

    public static void main(String[] args) {
        UserService service = new UserService();
        List<User> users = service.getAllUsers();
        LOGGER.log(Level.INFO, "Found {0} users", users.size());
    }
}
