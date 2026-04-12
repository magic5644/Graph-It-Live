package main

import (
	"fmt"
	"os"

	"github.com/example/myapp/utils"
)

func main() {
	args := os.Args
	result := utils.Process(args)
	fmt.Println(result)
}
