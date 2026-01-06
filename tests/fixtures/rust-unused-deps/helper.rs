// Helper module with a public function
pub fn format_data(data: &str) -> String {
    format!("[{}]", data)
}

// Private function - not visible outside
fn internal_helper() {
    println!("Internal helper");
}
