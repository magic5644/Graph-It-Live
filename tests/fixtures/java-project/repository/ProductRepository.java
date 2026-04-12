package com.example.myapp.repository; // NOSONAR - test fixture, directory does not match package

import com.example.myapp.models.Product;

import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

public class ProductRepository {
    private final List<Product> store = new ArrayList<>();

    public List<Product> findAll() {
        return new ArrayList<>(store);
    }

    public List<Product> findAvailable() {
        List<Product> available = new ArrayList<>();
        for (Product p : store) {
            if (p.isAvailable()) available.add(p);
        }
        return available;
    }

    public Optional<Product> findById(int id) {
        return store.stream().filter(p -> p.getId() == id).findFirst();
    }

    public void save(Product product) {
        store.add(product);
    }

    public boolean deleteById(int id) {
        return store.removeIf(p -> p.getId() == id);
    }
}
