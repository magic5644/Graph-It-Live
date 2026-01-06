pub struct Connection {
    pub url: String,
}

pub fn connect_db() -> Connection {
    Connection {
        url: String::from("localhost:5432"),
    }
}

pub fn disconnect_db(_conn: Connection) {
    println!("Disconnected");
}
