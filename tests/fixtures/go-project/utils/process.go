package utils

import (
	"fmt"
	"strings"
)

// Process handles the command-line arguments and returns a result string.
func Process(args []string) string {
	if len(args) < 2 {
		return "usage: myapp <command>"
	}
	return fmt.Sprintf("running: %s", strings.Join(args[1:], " "))
}

// Sanitize removes leading/trailing whitespace from a string.
func Sanitize(s string) string {
	return strings.TrimSpace(s)
}
