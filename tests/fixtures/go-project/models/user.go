package models

import "time"

// User represents an application user.
type User struct {
	ID        int
	Name      string
	Email     string
	CreatedAt time.Time
}

// String returns a human-readable representation of the user.
func (u *User) String() string {
	return u.Name + " <" + u.Email + ">"
}
