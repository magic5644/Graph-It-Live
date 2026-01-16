/**
 * Test fixture: Class with methods for symbol hierarchy
 * Expected call graph: UserService.getUser() → Database.query()
 */

class Database {
    public query(sql: string): any[] {
        console.log(`Executing: ${sql}`);
        return [];
    }
}

export class UserService {
    private db: Database;

    constructor() {
        this.db = new Database();
    }

    public getUser(id: number): any {
        return this.db.query(`SELECT * FROM users WHERE id = ${id}`); // Line 21
    }

    public getAllUsers(): any[] {
        return this.db.query('SELECT * FROM users'); // Line 25
    }
}

// Expected SymbolNodes:
// - Database (class, lines 6-11)
// - Database.query (method, lines 7-10)
// - UserService (class, lines 13-27)
// - UserService.constructor (method, lines 16-18)
// - UserService.getUser (method, lines 20-22)
// - UserService.getAllUsers (method, lines 24-26)

// Expected CallEdges:
// - UserService.getUser → Database.query (line 21, calls)
// - UserService.getAllUsers → Database.query (line 25, calls)

// Expected Graph:
// UserService.getUser ──→ Database.query
//                         ↑
// UserService.getAllUsers ─┘
