use utils::helpers::format_data;
use utils::helpers::process_data; // UNUSED - should be filtered/dimmed
use utils::database::{connect_db, disconnect_db}; // disconnect_db is UNUSED

pub fn main() {
    let connection = connect_db();
    let data = format_data("Hello Rust!");
    println!("{}", data);
    // Note: process_data and disconnect_db are imported but never called
}
