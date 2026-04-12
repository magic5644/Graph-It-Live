package main

import (
	"fmt"
	"net/http"
	"os"

	"github.com/example/myapp/config"
	"github.com/example/myapp/server"
	"github.com/example/myapp/utils"
)

func main() {
	args := os.Args
	result := utils.Process(args)
	fmt.Println(result)

	cfg := config.Load()
	router := server.NewRouter()
	addr := fmt.Sprintf(":%d", cfg.Port)
	fmt.Printf("listening on %s\n", addr)
	if err := http.ListenAndServe(addr, router); err != nil {
		fmt.Fprintf(os.Stderr, "server error: %v\n", err)
		os.Exit(1)
	}
}
