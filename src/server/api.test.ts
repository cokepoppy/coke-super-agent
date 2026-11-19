import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createHttpServer } from './http.ts';
import { pool } from './db.ts';
import { migrate } from './migrate.ts';
import { seedLocalTenants } from './seed.ts';

after(async () => { await pool.end(); });

function cookie(response: Response): string {
  const header = response.headers.get('set-cookie') || '';
  const value = header.split(';', 1)[0];
  assert.match(value, /^csa_session=[A-Za-z0-9_-]{43}$/);
  return value;
}

test('local tenant tasks and persisted events stay isolated across demo accounts', async () => {
  const alphaPassword = process.env.CSA_TEST_PASSWORD_ALPHA || '';
  const betaPassword = process.env.CSA_TEST_PASSWORD_BETA || '';
  assert.ok(alphaPassword.length >= 10, 'external local env must provide the Alpha test password');
  assert.ok(betaPassword.length >= 10, 'external local env must provide the Beta test password');
  await migrate();
  await seedLocalTenants();

  const server = createHttpServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  const origin = 'http://127.0.0.1:' + address.port;
  let alphaCookie = '';
  let betaCookie = '';
  let tenantId = '';
  let runId = '';
  let threadId = '';

  async function doLogin(username: string, password: string): Promise<string> {
    const response = await fetch(origin + '/api/auth/login', {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    assert.equal(response.status, 200);
    return cookie(response);
  }

  try {
    alphaCookie = await doLogin('alice', alphaPassword);
    betaCookie = await doLogin('bob', betaPassword);

    const alphaSession = await fetch(origin + '/api/auth/session', { headers: { cookie: alphaCookie } });
    assert.equal(alphaSession.status, 200);
    tenantId = (await alphaSession.json() as { session: { tenant: { id: string } } }).session.tenant.id;

    const created = await fetch(origin + '/api/tasks', {
      method: 'POST',
      headers: { cookie: alphaCookie, origin, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: '在 Alpha 租户里保存一条隔离测试任务。' }),
    });
    assert.equal(created.status, 201);
    const task = (await created.json() as { task: { id: string; threadId: string; status: string } }).task;
    runId = task.id;
    threadId = task.threadId;
    assert.equal(task.status, 'queued');

    const alphaTasks = await fetch(origin + '/api/tasks', { headers: { cookie: alphaCookie } });
    assert.equal(alphaTasks.status, 200);
    assert.equal((await alphaTasks.json() as { tasks: unknown[] }).tasks.length, 1);

    const betaTasks = await fetch(origin + '/api/tasks', { headers: { cookie: betaCookie } });
    assert.equal(betaTasks.status, 200);
    assert.deepEqual((await betaTasks.json() as { tasks: unknown[] }).tasks, []);

    const crossTenantDetail = await fetch(origin + '/api/tasks/' + encodeURIComponent(runId), { headers: { cookie: betaCookie } });
    assert.equal(crossTenantDetail.status, 404);

    const anonymousDetail = await fetch(origin + '/api/tasks/' + encodeURIComponent(runId));
    assert.equal(anonymousDetail.status, 401);

    const aliceEvents = await fetch(origin + '/api/tasks/' + encodeURIComponent(runId) + '/events', { headers: { cookie: alphaCookie } });
    assert.equal(aliceEvents.status, 200);
    assert.match(aliceEvents.headers.get('content-type') || '', /^text\/event-stream/);
    const reader = aliceEvents.body!.getReader();
    let eventText = '';
    for (let attempt = 0; attempt < 5 && !eventText.includes('"type":"queued"'); attempt += 1) {
      const part = await reader.read();
      if (part.done) break;
      eventText += new TextDecoder().decode(part.value);
    }
    await reader.cancel();
    assert.match(eventText, /"type":"queued"/);
    assert.match(eventText, /任务已保存/);

    const detailResponse = await fetch(origin + '/api/tasks/' + encodeURIComponent(runId), { headers: { cookie: alphaCookie } });
    assert.equal(detailResponse.status, 200);
    const detail = (await detailResponse.json() as { task: { prompt: string; events: unknown[] } }).task;
    assert.equal(detail.prompt, '在 Alpha 租户里保存一条隔离测试任务。');
    assert.equal(detail.events.length, 1);
  } finally {
    if (runId && tenantId) await pool.execute('DELETE FROM runs WHERE id = ? AND tenant_id = ?', [runId, tenantId]);
    if (threadId && tenantId) await pool.execute('DELETE FROM threads WHERE id = ? AND tenant_id = ?', [threadId, tenantId]);
    for (const value of [alphaCookie, betaCookie]) {
      if (value) {
        const response = await fetch(origin + '/api/auth/logout', { method: 'POST', headers: { cookie: value, origin, 'content-type': 'application/json' }, body: '{}' });
        assert.equal(response.status, 200);
      }
    }
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
