package com.example.myapp.models; // NOSONAR - test fixture, directory does not match package

import java.math.BigDecimal;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.List;

public class Order {
    private int id;
    private User customer;
    private List<Product> items;
    private LocalDateTime createdAt;

    public Order(int id, User customer) {
        this.id = id;
        this.customer = customer;
        this.items = new ArrayList<>();
        this.createdAt = LocalDateTime.now();
    }

    public int getId() { return id; }
    public User getCustomer() { return customer; }
    public List<Product> getItems() { return items; }
    public LocalDateTime getCreatedAt() { return createdAt; }

    public void addItem(Product product) {
        items.add(product);
    }

    public BigDecimal getTotal() {
        return items.stream()
                .map(Product::getPrice)
                .reduce(BigDecimal.ZERO, BigDecimal::add);
    }

    @Override
    public String toString() {
        return "Order{" + id + ", customer=" + customer.getName() + ", items=" + items.size() + "}";
    }
}
