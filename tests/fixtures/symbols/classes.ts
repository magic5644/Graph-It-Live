/**
 * Test fixture for T055: Color-coded symbols by type
 * Classes (purple), Methods (blue), Properties (amber)
 */

// Class definition - should be purple (#9966CC)
export class UserService {
  // Property - should be amber (#FFA500)
  private baseUrl: string = 'https://api.example.com';
  
  // Method - should be blue (#4A9EFF)
  async getUser(id: number): Promise<User> {
    const response = await fetch(`${this.baseUrl}/users/${id}`);
    return response.json();
  }
  
  // Method - should be blue
  async createUser(data: UserData): Promise<User> {
    const response = await fetch(`${this.baseUrl}/users`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
    return response.json();
  }
  
  // Private method - should be blue
  private validateUser(user: User): boolean {
    return !!user.name && !!user.email;
  }
}

// Another class - purple
export class AuthService {
  // Property - amber
  private tokenKey: string = 'auth_token';
  
  // Method - blue
  login(username: string, password: string): Promise<string> {
    return fetch('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }).then(r => r.json()).then(data => data.token);
  }
  
  // Method - blue
  logout(): void {
    localStorage.removeItem(this.tokenKey);
  }
}

// Interfaces and types for type safety
interface User {
  id: number;
  name: string;
  email: string;
}

interface UserData {
  name: string;
  email: string;
}
