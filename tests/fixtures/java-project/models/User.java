package com.example.myapp.models; // NOSONAR - test fixture, directory does not match package

import java.time.LocalDateTime;
import java.util.Objects;

public class User {
    private int id;
    private String name;
    private String email;
    private LocalDateTime createdAt;

    public User(int id, String name, String email) {
        this.id = id;
        this.name = name;
        this.email = email;
        this.createdAt = LocalDateTime.now();
    }

    public int getId() { return id; }
    public String getName() { return name; }
    public String getEmail() { return email; }
    public LocalDateTime getCreatedAt() { return createdAt; }

    @Override
    public boolean equals(Object o) {
        if (this == o) return true;
        if (!(o instanceof User)) return false;
        User user = (User) o;
        return id == user.id && Objects.equals(email, user.email);
    }

    @Override
    public int hashCode() { return Objects.hash(id, email); }

    @Override
    public String toString() { return "User{" + id + ", " + name + "}"; }
}
