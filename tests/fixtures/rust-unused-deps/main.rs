// Main file that uses helper module
mod helper;
mod unused;

fn main() {
    // Use format_data from helper - this creates a USED dependency
    let data = helper::format_data("test");
    println!("{}", data);
    
    // Note: unused module is imported but never used
}
