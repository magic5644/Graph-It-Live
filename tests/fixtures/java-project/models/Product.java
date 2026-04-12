package com.example.myapp.models; // NOSONAR - test fixture, directory does not match package

import java.math.BigDecimal;
import java.util.Objects;

public class Product {
    private int id;
    private String name;
    private BigDecimal price;
    private int stock;

    public Product(int id, String name, BigDecimal price, int stock) {
        this.id = id;
        this.name = name;
        this.price = price;
        this.stock = stock;
    }

    public int getId() { return id; }
    public String getName() { return name; }
    public BigDecimal getPrice() { return price; }
    public int getStock() { return stock; }
    public boolean isAvailable() { return stock > 0; }

    @Override
    public boolean equals(Object o) {
        if (this == o) return true;
        if (!(o instanceof Product)) return false;
        Product product = (Product) o;
        return id == product.id && Objects.equals(name, product.name);
    }

    @Override
    public int hashCode() { return Objects.hash(id, name); }

    @Override
    public String toString() { return "Product{" + id + ", " + name + ", $" + price + "}"; }
}
