import { createHash } from 'node:crypto';
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';

const queryTimeoutMs = 5_000;

export class TenantRunLeaseLostError extends Error {
  constructor(message = 'Tenant run lease was lost; task outcome must be reconciled before continuing.') {
    super(message);
    this.name = 'TenantRunLeaseLostError';
  }
}

export interface TenantRunLease {
  readonly connection: PoolConnection;
  assertOwned(): Promise<void>;
  release(): Promise<void>;
}

function lockName(database: string, tenantId: string): string {
  const digest = createHash('sha256').update(database).update('\0').update(tenantId).digest('hex');
  return `csa-run:${digest.slice(0, 48)}`;
}

async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Tenant run lease query timed out.')), queryTimeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// A separate connection owns the MySQL named lock until the whole tenant drain
// finishes. On an unconfirmed release the connection is destroyed, never
// returned to the pool while it might still own a lock.
export async function tryAcquireTenantRunLease(
  leasePool: Pick<Pool, 'getConnection'>,
  database: string,
  tenantId: string,
): Promise<TenantRunLease | null> {
  const connection = await leasePool.getConnection();
  const name = lockName(database, tenantId);
  let lost = false;
  let released = false;
  let destroyed = false;
  const destroy = () => {
    if (!destroyed) {
      destroyed = true;
      connection.destroy();
    }
  };
  const onConnectionError = () => { lost = true; };
  connection.on('error', onConnectionError);

  try {
    const [rows] = await bounded(connection.execute<RowDataPacket[]>('SELECT GET_LOCK(?, 0) AS acquired', [name]));
    const value = rows[0]?.acquired;
    if (lost) throw new TenantRunLeaseLostError();
    if (value === 0 || value === '0') {
      connection.removeListener('error', onConnectionError);
      connection.release();
      return null;
    }
    if (value !== 1 && value !== '1') throw new Error('MySQL could not acquire the tenant run lease.');
  } catch (error) {
    connection.removeListener('error', onConnectionError);
    destroy();
    throw error;
  }

  return {
    connection,
    async assertOwned() {
      if (lost || released) throw new TenantRunLeaseLostError();
      try {
        const [rows] = await bounded(connection.execute<RowDataPacket[]>(
          'SELECT IS_USED_LOCK(?) = CONNECTION_ID() AS owned', [name],
        ));
        if (lost || Number(rows[0]?.owned) !== 1) throw new TenantRunLeaseLostError();
      } catch {
        lost = true;
        destroy();
        throw new TenantRunLeaseLostError();
      }
    },
    async release() {
      if (released) return;
      released = true;
      try {
        if (lost) {
          destroy();
          return;
        }
        const [rows] = await bounded(connection.execute<RowDataPacket[]>('SELECT RELEASE_LOCK(?) AS released', [name]));
        if (lost || Number(rows[0]?.released) !== 1) destroy();
        else connection.release();
      } catch {
        destroy();
      } finally {
        connection.removeListener('error', onConnectionError);
      }
    },
  };
}
