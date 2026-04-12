package server

import (
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/example/myapp/middleware"
	"github.com/example/myapp/models"
)

var users = []*models.User{
	{ID: 1, Name: "Alice", Email: "alice@example.com"},
	{ID: 2, Name: "Bob", Email: "bob@example.com"},
}

// NewRouter creates a mux with all application routes registered.
func NewRouter() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/users", handleUsers)
	mux.HandleFunc("/health", handleHealth)
	return middleware.Auth(mux)
}

func handleUsers(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(users); err != nil {
		http.Error(w, fmt.Sprintf("encode error: %v", err), http.StatusInternalServerError)
	}
}

func handleHealth(w http.ResponseWriter, _ *http.Request) {
	fmt.Fprint(w, "ok")
}
