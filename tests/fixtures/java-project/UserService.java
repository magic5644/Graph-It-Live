package com.example.myapp; // NOSONAR - test fixture, directory does not match package

import com.example.myapp.models.User;
import com.example.myapp.repository.UserRepository;

import java.util.List;
import java.util.Optional;
import java.util.logging.Level;
import java.util.logging.Logger;

public class UserService {
    private static final Logger LOGGER = Logger.getLogger(UserService.class.getName());

    private final UserRepository repository;

    public UserService() {
        this.repository = new UserRepository();
    }

    public List<User> getAllUsers() {
        LOGGER.info("Fetching all users");
        return repository.findAll();
    }

    public Optional<User> getUserById(int id) {
        return repository.findById(id);
    }

    public void createUser(String name, String email) {
        if (name == null || name.isEmpty()) {
            LOGGER.warning("Cannot create user with empty name");
            return;
        }
        int id = repository.findAll().size() + 1;
        User user = new User(id, name, email);
        repository.save(user);
        LOGGER.log(Level.INFO, "User created: {0}", user);
    }

    public boolean deleteUser(int id) {
        boolean removed = repository.deleteById(id);
        if (removed) {
            LOGGER.log(Level.INFO, "Deleted user {0}", id);
        } else {
            LOGGER.log(Level.WARNING, "User {0} not found", id);
        }
        return removed;
    }
}
