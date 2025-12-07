import { UserService } from './service';

const userService = new UserService();

export function handleGetUser(userId: string) {
  return userService.getUser(userId);
}

export function handleCreateUser(name: string) {
  return userService.createUser(name);
}
