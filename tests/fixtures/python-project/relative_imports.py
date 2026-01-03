# Relative imports test
from . import helpers
from .main import main
from .utils import helpers as h
from ..utils.helpers import calculate

def process_data(data: str) -> str:
    """Process data using relative imports"""
    value = calculate(5, 10)
    return f"{data} - {value}"
