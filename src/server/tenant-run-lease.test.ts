import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import type { Pool, PoolConnection } from 'mysql2/promise';
import { TenantRunLeaseLostError, tryAcquireTenantRunLease } from './tenant-run-lease.ts';

class FakeMysql {
  readonly locks = new Map<string, FakeConnection>();
  readonly connections: FakeConnection[] = [];
  readonly pool = {
    getConnection: async () => {
      const connection = new FakeConnection(this);
      this.connections.push(connection);
      return connection as unknown as PoolConnection;
    },
  } as Pick<Pool, 'getConnection'>;
}

class FakeConnection extends EventEmitter {
  destroyed = false;
  returned = false;
  failRelease = false;
  nullAcquire = false;

  constructor(private readonly mysql: FakeMysql) { super(); }

  async execute(sql: string, params: string[]) {
    if (this.destroyed) throw new Error('connection is closed');
    const name = params[0];
    if (sql.includes('GET_LOCK')) {
      if (this.nullAcquire) return [[{ acquired: null }], []];
      if (this.mysql.locks.has(name)) return [[{ acquired: 0 }], []];
      this.mysql.locks.set(name, this);
      return [[{ acquired: 1 }], []];
    }
    if (sql.includes('IS_USED_LOCK')) return [[{ owned: this.mysql.locks.get(name) === this ? 1 : 0 }], []];
    if (sql.includes('RELEASE_LOCK')) {
      if (this.failRelease) return [[{ released: null }], []];
      const owned = this.mysql.locks.get(name) === this;
      if (owned) this.mysql.locks.delete(name);
      return [[{ released: owned ? 1 : 0 }], []];
    }
    throw new Error('unexpected SQL');
  }

  release() { this.returned = true; }
  destroy() {
    this.destroyed = true;
    for (const [name, owner] of this.mysql.locks) if (owner === this) this.mysql.locks.delete(name);
  }
  disconnect() {
    this.destroy();
    this.emit('error', new Error('connection lost'));
  }
}

test('concurrent workers grant one lease for a tenant and retry after release', async () => {
  const mysql = new FakeMysql();
  const leases = await Promise.all(Array.from({ length: 20 }, () =>
    tryAcquireTenantRunLease(mysql.pool, 'csa_test', 'tenant-a')));
  const owners = leases.filter(lease => lease !== null);
  assert.equal(owners.length, 1);
  assert.equal(mysql.connections.filter(connection => connection.returned).length, 19);
  await owners[0]!.assertOwned();
  await owners[0]!.release();
  const next = await tryAcquireTenantRunLease(mysql.pool, 'csa_test', 'tenant-a');
  assert.ok(next);
  await next.release();
});

test('different tenants and database namespaces can proceed independently', async () => {
  const mysql = new FakeMysql();
  const first = await tryAcquireTenantRunLease(mysql.pool, 'csa_a', 'tenant-a');
  const second = await tryAcquireTenantRunLease(mysql.pool, 'csa_a', 'tenant-b');
  const otherDatabase = await tryAcquireTenantRunLease(mysql.pool, 'csa_b', 'tenant-a');
  assert.ok(first && second && otherDatabase);
  await Promise.all([first.release(), second.release(), otherDatabase.release()]);
});

test('a disconnected worker cannot keep using or release its successor lease', async () => {
  const mysql = new FakeMysql();
  const first = await tryAcquireTenantRunLease(mysql.pool, 'csa_test', 'tenant-a');
  assert.ok(first);
  mysql.connections[0].disconnect();
  const successor = await tryAcquireTenantRunLease(mysql.pool, 'csa_test', 'tenant-a');
  assert.ok(successor);
  await assert.rejects(first.assertOwned(), TenantRunLeaseLostError);
  await first.release();
  await successor.assertOwned();
  await successor.release();
});

test('an unconfirmed release destroys the connection instead of returning a held lock', async () => {
  const mysql = new FakeMysql();
  const lease = await tryAcquireTenantRunLease(mysql.pool, 'csa_test', 'tenant-a');
  assert.ok(lease);
  mysql.connections[0].failRelease = true;
  await lease.release();
  assert.equal(mysql.connections[0].destroyed, true);
  assert.equal(mysql.connections[0].returned, false);
  const next = await tryAcquireTenantRunLease(mysql.pool, 'csa_test', 'tenant-a');
  assert.ok(next);
  await next.release();
});

test('an indeterminate GET_LOCK result fails closed', async () => {
  const mysql = new FakeMysql();
  const connection = new FakeConnection(mysql);
  connection.nullAcquire = true;
  const pool = { getConnection: async () => connection as unknown as PoolConnection };
  await assert.rejects(tryAcquireTenantRunLease(pool, 'csa_test', 'tenant-a'));
  assert.equal(connection.destroyed, true);
  assert.equal(connection.returned, false);
});
