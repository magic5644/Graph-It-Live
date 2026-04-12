package config

import (
	"os"
	"strconv"
)

// Config holds runtime configuration loaded from environment variables.
type Config struct {
	Port    int
	DBPath  string
	Debug   bool
}

// Load reads configuration from environment variables with sensible defaults.
func Load() *Config {
	port, err := strconv.Atoi(getEnv("PORT", "8080"))
	if err != nil {
		port = 8080
	}
	return &Config{
		Port:   port,
		DBPath: getEnv("DB_PATH", "app.db"),
		Debug:  getEnv("DEBUG", "false") == "true",
	}
}

func getEnv(key, fallback string) string {
	if val := os.Getenv(key); val != "" {
		return val
	}
	return fallback
}
