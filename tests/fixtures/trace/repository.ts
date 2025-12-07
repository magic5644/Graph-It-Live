import { logOperation } from './logger';

interface User {
  id: string;
  name: string;
}

export class UserRepository {
  private users: Map<string, User> = new Map([
    ['1', { id: '1', name: 'Alice' }],
    ['2', { id: '2', name: 'Bob' }],
  ]);

  findById(id: string): User | undefined {
    logOperation('findById', id);
    return this.users.get(id);
  }

  save(user: User): void {
    logOperation('save', user.id);
    this.users.set(user.id, user);
  }
}
