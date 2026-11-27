import { beforeEach, expect, test, vi } from 'vitest';
import { createOidcProvider, updateOidcProvider } from './oidcProvider';

const tx = vi.hoisted(() => ({
  oidcProvider: {
    create: vi.fn(async () => ({ id: 'provider-1' })),
    update: vi.fn(async () => ({ id: 'provider-1' })),
  },
  oidcGroupMapping: { deleteMany: vi.fn(), createMany: vi.fn() },
}));

vi.mock('@/lib/prisma', () => ({
  default: { transaction: (callback: (client: typeof tx) => Promise<void>) => callback(tx) },
}));

beforeEach(() => {
  vi.clearAllMocks();
});

test('updateOidcProvider keeps the order of the mappings', async () => {
  const groups = ['/c', '/a', '/b'];

  await updateOidcProvider(
    'authentik',
    {},
    groups.map(group => ({ group, role: 'user', teamId: null, teamRole: null })),
  );

  const [{ data }] = tx.oidcGroupMapping.createMany.mock.calls[0] as any;

  expect(tx.oidcGroupMapping.deleteMany).toHaveBeenCalledWith({
    where: { oidcProviderId: 'provider-1' },
  });
  expect(data.map(({ group, position }) => [group, position])).toEqual([
    ['/c', 0],
    ['/a', 1],
    ['/b', 2],
  ]);
});

test('createOidcProvider leaves a provider with the same slug alone', async () => {
  tx.oidcProvider.create.mockRejectedValueOnce(
    Object.assign(new Error('Unique constraint failed on the fields: (`slug`)'), { code: 'P2002' }),
  );

  expect(await createOidcProvider('authentik', { name: 'Authentik' })).toBe(false);
  expect(tx.oidcProvider.update).not.toHaveBeenCalled();
  expect(tx.oidcGroupMapping.deleteMany).not.toHaveBeenCalled();
});
