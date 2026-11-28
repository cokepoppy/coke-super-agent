import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RowDataPacket } from 'mysql2/promise';
import { createHttpServer } from './http.ts';
import { pool } from './db.ts';
import { config } from './config.ts';
import { migrate } from './migrate.ts';
import { seedLocalTenants } from './seed.ts';
import { encryptSandboxTrafficToken } from './token-crypto.ts';
import { dispatchDueProactiveRules, getProactiveTicketContext } from './proactive-store.ts';

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
    const edgeRequestId = 'a'.repeat(32);
    const correlatedHealth = await fetch(origin + '/health', { headers: { 'x-csa-edge-request-id': edgeRequestId } });
    assert.equal(correlatedHealth.status, 200);
    assert.equal(correlatedHealth.headers.get('x-csa-request-id'), edgeRequestId);

    alphaCookie = await doLogin('alice', alphaPassword);
    betaCookie = await doLogin('bob', betaPassword);

    const anonymousBrowserState = await fetch(origin + '/api/computer/browser');
    assert.equal(anonymousBrowserState.status, 401);
    const browserState = await fetch(origin + '/api/computer/browser', { headers: { cookie: alphaCookie } });
    assert.equal(browserState.status, 200);
    assert.deepEqual(await browserState.json(), { browserState: 'unavailable' });
    const browserRetryWithoutDesktop = await fetch(origin + '/api/computer/browser/retry', {
      method: 'POST',
      headers: { cookie: betaCookie, origin, 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(browserRetryWithoutDesktop.status, 409);
    const crossOriginBrowserRetry = await fetch(origin + '/api/computer/browser/retry', {
      method: 'POST',
      headers: { cookie: alphaCookie, origin: 'https://unrelated.example', 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(crossOriginBrowserRetry.status, 403);

    const anonymousNoVncClient = await fetch(origin + '/novnc/vnc.html');
    assert.equal(anonymousNoVncClient.status, 401);
    const noVncClient = await fetch(origin + '/novnc/vnc.html?autoconnect=true&resize=scale&path=%2Fapi%2Fcomputer%2Fdesktop%2Fwebsockify', { headers: { cookie: alphaCookie } });
    assert.equal(noVncClient.status, 200);
    assert.match(noVncClient.headers.get('content-type') || '', /^text\/html/);
    assert.match(await noVncClient.text(), /app\/ui\.js/);
    const noVncRuntime = await fetch(origin + '/novnc/core/rfb.js', { headers: { cookie: alphaCookie } });
    assert.equal(noVncRuntime.status, 200);
    assert.match(noVncRuntime.headers.get('content-type') || '', /^text\/javascript/);
    assert.ok(Number(noVncRuntime.headers.get('content-length')) > 0);
    const noVncAudio = await fetch(origin + '/novnc/app/sounds/bell.oga', { headers: { cookie: alphaCookie } });
    assert.equal(noVncAudio.status, 200);
    assert.equal(noVncAudio.headers.get('content-type'), 'audio/ogg');
    await Promise.all([noVncRuntime.body?.cancel(), noVncAudio.body?.cancel()]);

    const alphaSession = await fetch(origin + '/api/auth/session', { headers: { cookie: alphaCookie } });
    assert.equal(alphaSession.status, 200);
    tenantId = (await alphaSession.json() as { session: { tenant: { id: string } } }).session.tenant.id;
    const alphaBeforeResponse = await fetch(origin + '/api/tasks', { headers: { cookie: alphaCookie } });
    const betaBeforeResponse = await fetch(origin + '/api/tasks', { headers: { cookie: betaCookie } });
    const alphaBefore = (await alphaBeforeResponse.json() as { tasks: Array<{ id: string }> }).tasks;
    const betaBefore = (await betaBeforeResponse.json() as { tasks: Array<{ id: string }> }).tasks;

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
    const alphaTaskRows = (await alphaTasks.json() as { tasks: Array<{ id: string }> }).tasks;
    assert.equal(alphaTaskRows.length, alphaBefore.length + 1);
    assert.ok(alphaTaskRows.some(item => item.id === runId));

    const betaTasks = await fetch(origin + '/api/tasks', { headers: { cookie: betaCookie } });
    assert.equal(betaTasks.status, 200);
    const betaTaskRows = (await betaTasks.json() as { tasks: Array<{ id: string }> }).tasks;
    assert.deepEqual(betaTaskRows.map(item => item.id), betaBefore.map(item => item.id));
    assert.ok(!betaTaskRows.some(item => item.id === runId));

    const alphaActivityResponse = await fetch(origin + '/api/activity', { headers: { cookie: alphaCookie } });
    assert.equal(alphaActivityResponse.status, 200);
    const alphaActivity = (await alphaActivityResponse.json() as { items: Array<{ runId: string; event: { type: string } }>; nextCursor: number | null }).items;
    assert.ok(alphaActivity.some(item => item.runId === runId && item.event.type === 'queued'));
    assert.ok(!alphaActivity.some(item => item.runId === runId && item.event.type === 'debug'));

    const alphaDebugActivityResponse = await fetch(origin + '/api/activity?debug=1', { headers: { cookie: alphaCookie } });
    assert.equal(alphaDebugActivityResponse.status, 200);
    const alphaDebugActivity = (await alphaDebugActivityResponse.json() as { items: Array<{ runId: string; event: { type: string } }> }).items;
    assert.ok(alphaDebugActivity.some(item => item.runId === runId && item.event.type === 'debug'));

    const betaActivityResponse = await fetch(origin + '/api/activity?debug=1', { headers: { cookie: betaCookie } });
    assert.equal(betaActivityResponse.status, 200);
    const betaActivity = (await betaActivityResponse.json() as { items: Array<{ runId: string }> }).items;
    assert.ok(!betaActivity.some(item => item.runId === runId));

    const anonymousActivity = await fetch(origin + '/api/activity');
    assert.equal(anonymousActivity.status, 401);
    const invalidActivityCursor = await fetch(origin + '/api/activity?before=not-a-cursor', { headers: { cookie: alphaCookie } });
    assert.equal(invalidActivityCursor.status, 400);

    const crossTenantDetail = await fetch(origin + '/api/tasks/' + encodeURIComponent(runId), { headers: { cookie: betaCookie } });
    assert.equal(crossTenantDetail.status, 404);

    const crossTenantArtifacts = await fetch(origin + '/api/tasks/' + encodeURIComponent(runId) + '/artifacts', { headers: { cookie: betaCookie } });
    assert.equal(crossTenantArtifacts.status, 404);
    const crossTenantArtifactDownload = await fetch(origin + '/api/tasks/' + encodeURIComponent(runId) + '/artifacts/download?path=agent-response.md', { headers: { cookie: betaCookie } });
    assert.equal(crossTenantArtifactDownload.status, 404);

    const anonymousDetail = await fetch(origin + '/api/tasks/' + encodeURIComponent(runId));
    assert.equal(anonymousDetail.status, 401);
    const anonymousArtifacts = await fetch(origin + '/api/tasks/' + encodeURIComponent(runId) + '/artifacts');
    assert.equal(anonymousArtifacts.status, 401);

    const invalidArtifactPath = await fetch(origin + '/api/tasks/' + encodeURIComponent(runId) + '/artifacts/download?path=..%2F..%2Fetc%2Fpasswd', { headers: { cookie: alphaCookie } });
    assert.equal(invalidArtifactPath.status, 400);

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
    assert.equal(detail.events.length, 2);
    assert.equal((detail.events[1] as { sequence: number }).sequence, 2);
    assert.equal((detail.events[1] as { type: string }).type, 'debug');
    assert.equal((detail.events[1] as { payload: { stage: string } }).payload.stage, 'task.created');
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

test('proactive rules are tenant isolated and dispatch idempotent Observe and active Tickets', async () => {
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
  const origin = `http://127.0.0.1:${address.port}`;
  let alphaCookie = '';
  let betaCookie = '';
  let tenantId = '';
  const ruleIds: string[] = [];
  const runIds: string[] = [];
  const threadIds: string[] = [];

  async function doLogin(username: string, password: string): Promise<string> {
    const response = await fetch(`${origin}/api/auth/login`, {
      method: 'POST', headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    assert.equal(response.status, 200);
    return cookie(response);
  }

  try {
    alphaCookie = await doLogin('alice', alphaPassword);
    betaCookie = await doLogin('bob', betaPassword);
    assert.equal((await fetch(`${origin}/api/proactive/rules`)).status, 401);
    const alphaSession = await fetch(`${origin}/api/auth/session`, { headers: { cookie: alphaCookie } });
    tenantId = (await alphaSession.json() as { session: { tenant: { id: string } } }).session.tenant.id;

    const crossOrigin = await fetch(`${origin}/api/proactive/rules`, {
      method: 'POST', headers: { cookie: alphaCookie, origin: 'https://unrelated.example', 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'blocked', prompt: 'observe', intervalMinutes: 1 }),
    });
    assert.equal(crossOrigin.status, 403);

    const invalid = await fetch(`${origin}/api/proactive/rules`, {
      method: 'POST', headers: { cookie: alphaCookie, origin, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'invalid', prompt: 'observe', intervalMinutes: 0, mode: 'active' }),
    });
    assert.equal(invalid.status, 400);

    const observeResponse = await fetch(`${origin}/api/proactive/rules`, {
      method: 'POST', headers: { cookie: alphaCookie, origin, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Observe BSE page', prompt: 'Read the public rules page and report changes.', intervalMinutes: 1 }),
    });
    assert.equal(observeResponse.status, 201);
    const observeRule = (await observeResponse.json() as { rule: { id: string; mode: string; enabled: boolean } }).rule;
    ruleIds.push(observeRule.id);
    assert.equal(observeRule.mode, 'observe');
    assert.equal(observeRule.enabled, true);
    const betaRules = await fetch(`${origin}/api/proactive/rules`, { headers: { cookie: betaCookie } });
    assert.deepEqual((await betaRules.json() as { rules: unknown[] }).rules, []);
    const crossTenantPatch = await fetch(`${origin}/api/proactive/rules/${observeRule.id}`, {
      method: 'PATCH', headers: { cookie: betaCookie, origin, 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(crossTenantPatch.status, 404);

    const pause = await fetch(`${origin}/api/proactive/rules/${observeRule.id}`, {
      method: 'PATCH', headers: { cookie: alphaCookie, origin, 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal((await pause.json() as { rule: { enabled: boolean } }).rule.enabled, false);
    const resume = await fetch(`${origin}/api/proactive/rules/${observeRule.id}`, {
      method: 'PATCH', headers: { cookie: alphaCookie, origin, 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal((await resume.json() as { rule: { enabled: boolean } }).rule.enabled, true);

    await pool.execute('UPDATE proactive_rules SET next_run_at = DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 2 SECOND) WHERE id = ? AND tenant_id = ?', [observeRule.id, tenantId]);
    const observed = await dispatchDueProactiveRules(new Date());
    assert.equal(observed.length, 1);
    assert.equal(observed[0]?.outcome, 'observed');
    assert.equal(observed[0]?.runId, undefined);

    const activeResponse = await fetch(`${origin}/api/proactive/rules`, {
      method: 'POST', headers: { cookie: alphaCookie, origin, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Read BSE rules', prompt: 'Open the public BSE rule index and summarize the latest published rule title.', intervalMinutes: 1, mode: 'active' }),
    });
    assert.equal(activeResponse.status, 201);
    const activeRule = (await activeResponse.json() as { rule: { id: string; mode: string } }).rule;
    ruleIds.push(activeRule.id);
    assert.equal(activeRule.mode, 'active');
    await pool.execute('UPDATE proactive_rules SET next_run_at = DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 2 SECOND) WHERE id = ? AND tenant_id = ?', [activeRule.id, tenantId]);
    const concurrent = await Promise.all([dispatchDueProactiveRules(new Date()), dispatchDueProactiveRules(new Date())]);
    const queued = concurrent.flat();
    assert.equal(queued.filter(item => item.ruleId === activeRule.id).length, 1);
    const ticket = queued.find(item => item.ruleId === activeRule.id);
    assert.equal(ticket?.outcome, 'queued');
    assert.ok(ticket?.runId);
    runIds.push(ticket!.runId!);
    const [runRows] = await pool.execute<RowDataPacket[]>('SELECT thread_id, status, prompt FROM runs WHERE id = ? AND tenant_id = ?', [ticket!.runId, tenantId]);
    assert.equal(runRows[0]?.status, 'queued');
    assert.equal(runRows[0]?.prompt, 'Open the public BSE rule index and summarize the latest published rule title.');
    threadIds.push(String(runRows[0]?.thread_id));
    const context = await getProactiveTicketContext(tenantId, ticket!.runId!);
    assert.equal(context?.ticketId, ticket?.occurrenceId);
    assert.equal(context?.ruleName, 'Read BSE rules');
    assert.equal(context?.source, 'schedule');
    const editRule = await fetch(`${origin}/api/proactive/rules/${activeRule.id}`, {
      method: 'PATCH', headers: { cookie: alphaCookie, origin, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Edited future rule', prompt: 'A later mandate.' }),
    });
    assert.equal(editRule.status, 200);
    const frozenContext = await getProactiveTicketContext(tenantId, ticket!.runId!);
    assert.equal(frozenContext?.ruleName, 'Read BSE rules');
    assert.equal(frozenContext?.mandate, 'Open the public BSE rule index and summarize the latest published rule title.');
    const deleteOutstanding = await fetch(`${origin}/api/proactive/rules/${activeRule.id}`, {
      method: 'DELETE', headers: { cookie: alphaCookie, origin, 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(deleteOutstanding.status, 409);

    await pool.execute('UPDATE proactive_rules SET next_run_at = DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 1 SECOND) WHERE id = ? AND tenant_id = ?', [activeRule.id, tenantId]);
    const skipped = await dispatchDueProactiveRules(new Date());
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0]?.ruleId, activeRule.id);
    assert.equal(skipped[0]?.outcome, 'skipped_busy');
    assert.equal(skipped[0]?.runId, undefined);

    const alphaList = await fetch(`${origin}/api/proactive/rules`, { headers: { cookie: alphaCookie } });
    const state = await alphaList.json() as { rules: Array<{ id: string }>; occurrences: Array<{ ruleId: string; outcome: string; runId: string | null }> };
    assert.equal(state.rules.length, 2);
    assert.ok(state.occurrences.some(item => item.ruleId === observeRule.id && item.outcome === 'observed'));
    assert.ok(state.occurrences.some(item => item.ruleId === activeRule.id && item.outcome === 'queued' && item.runId === ticket?.runId));
    assert.ok(state.occurrences.some(item => item.ruleId === activeRule.id && item.outcome === 'skipped_busy'));
  } finally {
    if (ruleIds.length) await pool.execute(`DELETE FROM proactive_rules WHERE tenant_id = ? AND id IN (${ruleIds.map(() => '?').join(',')})`, [tenantId, ...ruleIds]);
    if (runIds.length) await pool.execute(`DELETE FROM runs WHERE tenant_id = ? AND id IN (${runIds.map(() => '?').join(',')})`, [tenantId, ...runIds]);
    if (threadIds.length) await pool.execute(`DELETE FROM threads WHERE tenant_id = ? AND id IN (${threadIds.map(() => '?').join(',')})`, [tenantId, ...threadIds]);
    for (const value of [alphaCookie, betaCookie]) {
      if (value) await fetch(`${origin}/api/auth/logout`, { method: 'POST', headers: { cookie: value, origin, 'content-type': 'application/json' }, body: '{}' });
    }
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test('a missing tenant VM keeps its identity and fails safely on repeated starts', async () => {
  const previousCube = { ...config.cube };
  const previousEncryptionKey = config.tokenEncryptionKey;
  const requests: string[] = [];
  const fakeCube = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: 'Sandbox not found' }));
  });
  const server = createHttpServer();
  let tenantId = '';
  let sessionCookie = '';
  let fixtureSandboxId = '';
  try {
    await new Promise<void>(resolve => fakeCube.listen(0, '127.0.0.1', resolve));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const cubeAddress = fakeCube.address() as AddressInfo;
    const address = server.address() as AddressInfo;
    const origin = `http://127.0.0.1:${address.port}`;
    config.cube.apiUrl = `http://127.0.0.1:${cubeAddress.port}`;
    config.cube.apiKey = '';
    config.cube.templateId = 'test-template';
    config.tokenEncryptionKey = randomBytes(32).toString('base64url');

    const login = await fetch(`${origin}/api/auth/login`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: process.env.CSA_TEST_PASSWORD_ALPHA }),
    });
    assert.equal(login.status, 200);
    sessionCookie = cookie(login);
    const session = await fetch(`${origin}/api/auth/session`, { headers: { cookie: sessionCookie } });
    tenantId = (await session.json() as { session: { tenant: { id: string } } }).session.tenant.id;
    const sandboxId = `missing-${randomUUID()}`;
    const ciphertext = encryptSandboxTrafficToken('test-only-traffic-token');
    const [fixture] = await pool.execute(
      "UPDATE computers SET sandbox_id = ?, template_id = ?, cube_traffic_token_ciphertext = ?, state = 'running', desktop_state = 'ready', generation = 1 WHERE tenant_id = ? AND sandbox_id IS NULL AND state = 'not_created'",
      [sandboxId, 'test-template', ciphertext, tenantId],
    );
    assert.equal((fixture as { affectedRows: number }).affectedRows, 1);
    fixtureSandboxId = sandboxId;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await fetch(`${origin}/api/computer/start`, {
        method: 'POST',
        headers: { cookie: sessionCookie, origin, 'content-type': 'application/json' },
        body: '{}',
      });
      assert.equal(response.status, 409);
      assert.match((await response.json() as { error: string }).error, /工作区可能需要恢复.*未创建空白电脑/);
      const [rows] = await pool.execute<RowDataPacket[]>(
        'SELECT sandbox_id, cube_traffic_token_ciphertext, state, desktop_state FROM computers WHERE tenant_id = ?',
        [tenantId],
      );
      assert.equal(rows[0]?.sandbox_id, sandboxId);
      assert.equal(rows[0]?.cube_traffic_token_ciphertext, ciphertext);
      assert.equal(rows[0]?.state, 'failed');
      assert.equal(rows[0]?.desktop_state, 'failed');
    }
    assert.deepEqual(requests, [`GET /sandboxes/${sandboxId}`, `GET /sandboxes/${sandboxId}`]);
  } finally {
    if (tenantId && fixtureSandboxId) {
      await pool.execute(
        "UPDATE computers SET sandbox_id = NULL, template_id = NULL, cube_traffic_token_ciphertext = NULL, state = 'not_created', desktop_state = 'pending', desktop_updated_at = NULL, generation = 0 WHERE tenant_id = ? AND sandbox_id = ?",
        [tenantId, fixtureSandboxId],
      );
    }
    if (sessionCookie) {
      const address = server.address() as AddressInfo;
      const origin = `http://127.0.0.1:${address.port}`;
      await fetch(`${origin}/api/auth/logout`, { method: 'POST', headers: { cookie: sessionCookie, origin } });
    }
    Object.assign(config.cube, previousCube);
    config.tokenEncryptionKey = previousEncryptionKey;
    server.closeAllConnections();
    fakeCube.closeAllConnections();
    await Promise.all([
      new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
      new Promise<void>((resolve, reject) => fakeCube.close(error => error ? reject(error) : resolve())),
    ]);
  }
});

test('an uncertain VM create retains its workspace and prevents a duplicate create', async () => {
  const previousCube = { ...config.cube };
  const previousEncryptionKey = config.tokenEncryptionKey;
  const helperDir = await mkdtemp(join(tmpdir(), 'csa-workspace-test-'));
  const helperPath = join(helperDir, 'fake-limactl');
  await writeFile(helperPath, '#!/bin/sh\n[ "$#" = 7 ] && [ "$6" = /usr/local/sbin/csa-ensure-tenant-workspace ] || exit 1\nprintf "/data/shared/csa-tenant-workspaces/%s\\n" "$7"\n', { mode: 0o700 });
  const requests: Array<{ method: string; path: string; body: string }> = [];
  const fakeCube = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      requests.push({ method: req.method || '', path: req.url || '', body });
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: 'test response after create dispatch' }));
    });
  });
  const server = createHttpServer();
  let tenantId = '';
  let sessionCookie = '';
  try {
    await new Promise<void>(resolve => fakeCube.listen(0, '127.0.0.1', resolve));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const cubeAddress = fakeCube.address() as AddressInfo;
    const address = server.address() as AddressInfo;
    const origin = `http://127.0.0.1:${address.port}`;
    config.cube.apiUrl = `http://127.0.0.1:${cubeAddress.port}`;
    config.cube.apiKey = '';
    config.cube.templateId = 'test-template';
    config.cube.workspaceMode = 'lima';
    config.cube.limaCommand = helperPath;
    config.tokenEncryptionKey = randomBytes(32).toString('base64url');
    const login = await fetch(`${origin}/api/auth/login`, {
      method: 'POST', headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: process.env.CSA_TEST_PASSWORD_ALPHA }),
    });
    assert.equal(login.status, 200);
    sessionCookie = cookie(login);
    const session = await fetch(`${origin}/api/auth/session`, { headers: { cookie: sessionCookie } });
    tenantId = (await session.json() as { session: { tenant: { id: string } } }).session.tenant.id;

    const start = () => fetch(`${origin}/api/computer/start`, {
      method: 'POST', headers: { cookie: sessionCookie, origin, 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal((await start()).status, 502);
    const second = await start();
    assert.equal(second.status, 409);
    assert.match((await second.json() as { error: string }).error, /创建结果尚未确认.*暂停重复创建/);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.method, 'POST');
    assert.equal(requests[0]?.path, '/sandboxes');
    const payload = JSON.parse(requests[0]!.body) as { metadata: Record<string, string>; network: Record<string, unknown>; allow_internet_access?: boolean };
    assert.deepEqual(JSON.parse(payload.metadata['host-mount']!), [{ hostPath: `/data/shared/csa-tenant-workspaces/${tenantId}`, mountPath: '/workspace', readOnly: false }]);
    assert.deepEqual(payload.network, { allowPublicTraffic: false });
    assert.notEqual(payload.allow_internet_access, false);
    const [rows] = await pool.execute<RowDataPacket[]>('SELECT sandbox_id, create_pending, state FROM computers WHERE tenant_id = ?', [tenantId]);
    assert.equal(rows[0]?.sandbox_id, null);
    assert.equal(rows[0]?.create_pending, 1);
    assert.equal(rows[0]?.state, 'failed');
  } finally {
    if (tenantId) {
      await pool.execute(
        "UPDATE computers SET create_pending = FALSE, state = 'not_created', desktop_state = 'pending', desktop_updated_at = NULL, generation = 0 WHERE tenant_id = ? AND sandbox_id IS NULL AND generation = 1",
        [tenantId],
      );
    }
    if (sessionCookie) {
      const address = server.address() as AddressInfo;
      const origin = `http://127.0.0.1:${address.port}`;
      await fetch(`${origin}/api/auth/logout`, { method: 'POST', headers: { cookie: sessionCookie, origin } });
    }
    Object.assign(config.cube, previousCube);
    config.tokenEncryptionKey = previousEncryptionKey;
    server.closeAllConnections();
    fakeCube.closeAllConnections();
    await Promise.all([
      new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
      new Promise<void>((resolve, reject) => fakeCube.close(error => error ? reject(error) : resolve())),
    ]);
    await unlink(helperPath);
    await rmdir(helperDir);
  }
});
