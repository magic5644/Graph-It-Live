# Helper functions
import math
from typing import List

def calculate(a: int, b: int) -> int:
    """Calculate sum of two numbers"""
    return a + b

def format_result(value: int) -> str:
    """Format result as string"""
    return f"Result: {value}"

def advanced_calc(values: List[int]) -> float:
    """Advanced calculation using math"""
    return math.sqrt(sum(values))
