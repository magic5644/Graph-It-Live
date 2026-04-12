package models

import "fmt"

// Product represents a product in the catalogue.
type Product struct {
	ID    int
	Name  string
	Price float64
	Stock int
}

// String returns a human-readable representation of the product.
func (p *Product) String() string {
	return fmt.Sprintf("%s ($%.2f)", p.Name, p.Price)
}

// Order groups a customer with their selected products.
type Order struct {
	ID       int
	Customer *User
	Items    []*Product
}

// Total returns the sum of all item prices.
func (o *Order) Total() float64 {
	total := 0.0
	for _, item := range o.Items {
		total += item.Price
	}
	return total
}
