# Main entry point for Python test project
import utils.helpers
from utils.helpers import calculate, format_result
from .relative_imports import process_data

def main():
    """Main function"""
    result = calculate(10, 20)
    formatted = format_result(result)
    processed = process_data(formatted)
    print(processed)

if __name__ == "__main__":
    main()
