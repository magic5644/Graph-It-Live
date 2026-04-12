package com.example.myapp.repository; // NOSONAR - test fixture, directory does not match package

import com.example.myapp.models.User;

import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

public class UserRepository {
    private final List<User> store = new ArrayList<>();

    public List<User> findAll() {
        return new ArrayList<>(store);
    }

    public Optional<User> findById(int id) {
        return store.stream().filter(u -> u.getId() == id).findFirst();
    }

    public Optional<User> findByEmail(String email) {
        return store.stream().filter(u -> u.getEmail().equalsIgnoreCase(email)).findFirst();
    }

    public void save(User user) {
        store.add(user);
    }

    public boolean deleteById(int id) {
        return store.removeIf(u -> u.getId() == id);
    }
}
