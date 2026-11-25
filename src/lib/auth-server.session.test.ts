import { beforeEach, expect, test, vi } from 'vitest';
import { checkAuth } from '@/lib/auth';
import { AUTH_SESSION_TTL } from '@/lib/constants';
import { createUserSession, getAuth, refreshUserSession } from './auth-server';

vi.hoisted(() => {
  process.env.APP_SECRET ??= 'test-app-secret';
});

// A real better-auth instance on an in-memory database, so the tests see which writes and
// cookies better-auth itself produces.
const db = vi.hoisted(() => ({
  user: [] as Record<string, any>[],
  authSession: [] as Record<string, any>[],
  account: [] as Record<string, any>[],
  verification: [] as Record<string, any>[],
}));

vi.mock('better-auth/adapters/prisma', async () => {
  const { memoryAdapter } = await import('better-auth/adapters/memory');
  return { prismaAdapter: () => memoryAdapter(db) };
});

vi.mock('@/lib/prisma', () => ({
  default: { client: { twoFactorAuth: { findUnique: async () => null } } },
}));

vi.mock('@/lib/redis', () => ({ default: { enabled: false } }));

vi.mock('@/lib/two-factor/policy', () => ({ isTwoFactorSetupRequired: async () => false }));

vi.mock('@/queries/prisma/user', () => ({
  getUser: async (id: string) => {
    const user = db.user.find(row => row.id === id);
    return user && { ...user, role: 'user', password: null };
  },
}));

const DAY = 24 * 60 * 60 * 1000;

let userId: string;

beforeEach(async () => {
  for (const rows of Object.values(db)) {
    rows.length = 0;
  }

  userId = 'user-1';
  db.user.push({
    id: userId,
    email: 'someone@example.com',
    emailVerified: false,
    name: 'Someone',
    username: 'someone',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
});

function sessionCookie(headers: Headers) {
  return headers.getSetCookie().find(cookie => cookie.includes('.session_token='));
}

async function signIn(url = 'http://localhost/api/auth/login') {
  const { token, headers } = await createUserSession(new Request(url, { method: 'POST' }), userId);
  const cookie = sessionCookie(headers).split(';')[0];

  return { token, cookie };
}

async function setExpiry(token: string, expiresAt: Date) {
  const ctx = await getAuth().$context;
  await ctx.internalAdapter.updateSession(token, { expiresAt });
}

async function storedExpiry(token: string) {
  const ctx = await getAuth().$context;
  return (await ctx.internalAdapter.findSession(token)).session.expiresAt.getTime();
}

test('an ordinary request authenticates without extending the session', async () => {
  const { token, cookie } = await signIn();
  const nearExpiry = new Date(Date.now() + 2 * DAY);
  await setExpiry(token, nearExpiry);

  const auth = await checkAuth(new Request('http://localhost/api/me', { headers: { cookie } }));

  expect(auth.user.id).toBe(userId);
  expect(await storedExpiry(token)).toBe(nearExpiry.getTime());
});

test('a session near its expiry is extended and its cookie reissued', async () => {
  const { token, cookie } = await signIn();
  await setExpiry(token, new Date(Date.now() + 2 * DAY));

  const headers = await refreshUserSession(
    new Request('http://localhost/api/auth/verify', { method: 'POST', headers: { cookie } }),
  );

  expect(await storedExpiry(token)).toBeGreaterThan(Date.now() + AUTH_SESSION_TTL * 1000 - DAY);
  expect(sessionCookie(headers)).toContain(`Max-Age=${AUTH_SESSION_TTL}`);
  expect(sessionCookie(headers).split(';')[0]).toBe(cookie);
});

test('a session refreshed within the last day is left as it is', async () => {
  const { token, cookie } = await signIn();
  const expiry = await storedExpiry(token);

  const headers = await refreshUserSession(
    new Request('http://localhost/api/auth/verify', { method: 'POST', headers: { cookie } }),
  );

  expect(sessionCookie(headers)).toBeUndefined();
  expect(await storedExpiry(token)).toBe(expiry);
});

test('a bearer token session is extended and keeps its token', async () => {
  const { token } = await signIn();
  await setExpiry(token, new Date(Date.now() + 2 * DAY));
  const authorization = `Bearer ${token}`;

  await refreshUserSession(
    new Request('http://localhost/api/auth/verify', { method: 'POST', headers: { authorization } }),
  );
  const auth = await checkAuth(
    new Request('http://localhost/api/me', { headers: { authorization } }),
  );

  expect(await storedExpiry(token)).toBeGreaterThan(Date.now() + AUTH_SESSION_TTL * 1000 - DAY);
  expect(auth.user.id).toBe(userId);
});
