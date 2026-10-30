import { db, isDatabaseConfigured } from './index.ts';
import { users } from './schema.ts';

export async function getOrCreateUser(uid: string, email: string) {
  if (!isDatabaseConfigured()) {
    return { id: 1, uid, email, createdAt: new Date() };
  }
  try {
    const [user] = await db
      .insert(users)
      .values({ uid, email })
      .onConflictDoUpdate({
        target: users.uid,
        set: { email },
      })
      .returning();

    return user;
  } catch (error) {
    throw new Error('Database query failed. Please try again later.', { cause: error });
  }
}
