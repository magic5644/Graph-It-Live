interface User {
  id: string;
  name: string;
}

export function formatUser(user: User | undefined): string {
  if (!user) return 'Unknown User';
  return `User: ${user.name} (ID: ${user.id})`;
}
