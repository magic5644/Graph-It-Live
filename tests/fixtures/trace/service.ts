import { UserRepository } from './repository';
import { formatUser } from './formatter';

const repo = new UserRepository();

export class UserService {
  getUser(userId: string) {
    const user = repo.findById(userId);
    return formatUser(user);
  }

  createUser(name: string) {
    const user = { id: 'new', name };
    repo.save(user);
    return formatUser(user);
  }
}
