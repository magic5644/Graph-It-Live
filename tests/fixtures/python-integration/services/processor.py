# Data processor service
from ..utils.helpers import parse_json, format_result

class DataProcessor:
    """Process data"""
    
    def __init__(self):
        self.cache = {}
    
    def process(self, data):
        """Process raw data"""
        processed = []
        for item in data:
            processed.append(self._transform(item))
        return processed
    
    def _transform(self, item):
        """Transform single item"""
        return {"id": item.get("id"), "processed": True}
    
    def clear_cache(self):
        """Clear processing cache"""
        self.cache = {}
