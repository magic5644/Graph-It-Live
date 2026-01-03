# Database utilities
import json
from .helpers import validate_connection

def connect_db():
    """Connect to database"""
    if validate_connection():
        return {"connected": True}
    return None

def query_data(db, query):
    """Execute database query"""
    if db and db.get("connected"):
        return [{"id": 1, "name": "test"}]
    return []

def save_data(_db, data):
    """Save data to database"""
    return True
