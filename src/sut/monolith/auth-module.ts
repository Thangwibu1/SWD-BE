import { createHash } from 'node:crypto';
import type { Database, SqlExecutor } from '../shared/database/db.js';
import type { AuthApi, LoginResult } from '../shared/domain/types.js';
import { DomainError } from '../shared/errors/domain-errors.js';

export function mockPasswordHash(email: string, password: string): string {
  return `mock-sha256$${createHash('sha256').update(`${email.toLowerCase()}:${password}`).digest('hex')}`;
}

export function createAuthModule(db: Database): AuthApi {
  return {
    async login(email: string, password: string): Promise<LoginResult> {
      const expected = mockPasswordHash(email, password);
      const result = await db.query<{ id: string; role: 'customer' | 'admin'; password_hash: string }>(
        'auth.login',
        `SELECT id, role, password_hash FROM users WHERE lower(email) = lower($1)`,
        [email],
      );
      const row = result.rows[0];
      if (!row || row.password_hash !== expected) {
        throw new DomainError('INVALID_CREDENTIALS');
      }
      // Mock JWT: benchmark doesn't verify tokens; k6 carries userId directly.
      const token = `mock-token-${row.id}`;
      return { userId: row.id, token, role: row.role };
    },

    async userExists(userId: string): Promise<boolean> {
      return userExists(db, userId);
    },
  };
}

export async function userExists(db: SqlExecutor, userId: string): Promise<boolean> {
  const r = await db.query<{ n: string }>('auth.exists', `SELECT 1 AS n FROM users WHERE id = $1`, [userId]);
  return r.rows.length > 0;
}
