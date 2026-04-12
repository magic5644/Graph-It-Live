package middleware

import (
	"fmt"
	"net/http"

	"github.com/example/myapp/models"
)

// AuthContext stores the authenticated user on a request context key.
type AuthContext struct {
	User *models.User
}

// Auth is a naive HTTP middleware that validates a bearer token header.
// In production use proper JWT validation.
func Auth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token := r.Header.Get("Authorization")
		if token == "" {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		// Stub: accept any non-empty token and set a placeholder user.
		fmt.Printf("auth: token accepted for %s\n", r.URL.Path)
		next.ServeHTTP(w, r)
	})
}
