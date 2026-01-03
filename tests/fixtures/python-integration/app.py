# Main application module
from utils.database import connect_db, query_data
from utils.helpers import format_result
from services.processor import DataProcessor

def run_application():
    """Main application entry point"""
    db = connect_db()
    raw_data = query_data(db, "SELECT * FROM users")
    
    processor = DataProcessor()
    processed = processor.process(raw_data)
    
    result = format_result(processed)
    return result

if __name__ == "__main__":
    run_application()
