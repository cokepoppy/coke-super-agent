#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const repoRequire = createRequire(new URL('../../package.json', import.meta.url));
const dotenv = repoRequire('dotenv');
dotenv.config({ path: process.env.DOTENV_CONFIG_PATH });

const baseUrl = (process.env.CSA_PUBLIC_BASE_URL || 'https://codex.cokeagent.com/super-agent').replace(/\/$/, '');
const origin = new URL(baseUrl).origin;
const alphaPassword = process.env.CSA_TEST_PASSWORD_ALPHA || '';
const betaPassword = process.env.CSA_TEST_PASSWORD_BETA || '';
const apiLabel = 'com.coke.super-agent.api';
const launchDomain = `gui/${process.getuid()}`;
const launchTarget = `${launchDomain}/${apiLabel}`;
const testId = randomUUID();
const marker = `csa-active-recovery-${testId}`;
const fileName = `active-recovery-${testId}.txt`;
const command = `printf '%s\\n' 'started ${marker}' > '${fileName}' && sleep 120 && printf '%s\\n' 'resumed ${marker}' >> '${fileName}' && cat '${fileName}'`;
const startedAt = Date.now();

function log(stage, details = {}) {
  process.stdout.write(JSON.stringify({ timestamp: new Date().toISOString(), stage, ...details }) + '\n');
}

function cookieFrom(response) {
  const header = response.headers.get('set-cookie') || '';
  const value = header.split(';', 1)[0];
  assert.match(value, /^csa_session=[A-Za-z0-9_-]{43}$/);
  return value;
}

async function fetchJson(path, options = {}, cookie = '') {
  const headers = new Headers(options.headers || {});
  if (cookie) headers.set('cookie', cookie);
  const response = await fetch(baseUrl + path, { ...options, headers, signal: AbortSignal.timeout(15_000) });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; }
  catch { body = { text: text.slice(0, 400) }; }
  return { response, body };
}

async function login(username, password) {
  const { response } = await fetchJson('/api/auth/login', {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(response.status, 200, `${username} login failed with HTTP ${response.status}`);
  return cookieFrom(response);
}

async function getTask(cookie, runId) {
  const { response, body } = await fetchJson(`/api/tasks/${encodeURIComponent(runId)}`, {}, cookie);
  assert.equal(response.status, 200, `task detail returned HTTP ${response.status}`);
  return body.task;
}

function launchAgentPid() {
  const result = spawnSync('/bin/launchctl', ['print', launchTarget], {
    encoding: 'utf8',
    timeout: 5000,
    env: { HOME: process.env.HOME, PATH: process.env.PATH },
  });
  const match = String(result.stdout || '').match(/^\s*pid = (\d+)\s*$/m);
  return match ? Number(match[1]) : null;
}

async function waitForHealth(timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const { response } = await fetchJson('/health');
      if (response.status === 200) return;
    } catch { /* The LaunchAgent may still be restarting. */ }
    await delay(1000);
  }
  throw new Error('Public Super Agent health did not return within the restart deadline.');
}

assert.ok(alphaPassword.length >= 10, 'CSA_TEST_PASSWORD_ALPHA is missing or too short.');
assert.ok(betaPassword.length >= 10, 'CSA_TEST_PASSWORD_BETA is missing or too short.');

const { response: healthResponse } = await fetchJson('/health');
assert.equal(healthResponse.status, 200, 'public health check failed before test');
const alphaCookie = await login('alice', alphaPassword);
const betaCookie = await login('bob', betaPassword);
const { response: tasksResponse, body: taskList } = await fetchJson('/api/tasks', {}, alphaCookie);
assert.equal(tasksResponse.status, 200);
const activeBefore = (taskList.tasks || []).filter(task => task.status === 'queued' || task.status === 'working');
assert.equal(activeBefore.length, 0, 'refusing to start while another Alpha task is active');

const prompt = [
  '这是一次受控的任务恢复验收。请只调用一次 Bash 工具，并执行下面给出的整条命令。',
  '不要使用浏览器、Computer Use 或其他工具；不要请求人工接管。等待命令完整结束并读取输出后再总结。',
  '',
  '```bash',
  command,
  '```',
].join('\n');
const { response: createdResponse, body: createdBody } = await fetchJson('/api/tasks', {
  method: 'POST',
  headers: { origin, 'content-type': 'application/json' },
  body: JSON.stringify({ prompt }),
}, alphaCookie);
assert.equal(createdResponse.status, 201, `task creation returned HTTP ${createdResponse.status}`);
const runId = createdBody.task.id;
log('task.created', { runId, fileName, model: createdBody.task.model || null });

let toolStarted = false;
let restartIssued = false;
const firstDeadline = Date.now() + 25 * 60_000;
while (Date.now() < firstDeadline && !toolStarted) {
  const task = await getTask(alphaCookie, runId);
  const traces = (task.events || []).filter(event => event.type === 'debug').map(event => event.payload || {});
  const toolEvent = traces.find(event => event.stage === 'harness.tool.start');
  if (toolEvent) {
    assert.match(String(toolEvent.details?.toolName || ''), /bash/i, 'expected the controlled Bash tool call');
    toolStarted = true;
    log('dsh.tool.started', { elapsedMs: Date.now() - startedAt, toolName: toolEvent.details?.toolName || 'bash' });
    break;
  }
  if (['failed', 'done'].includes(task.status)) throw new Error(`task reached ${task.status} before the controlled Bash call`);
  await delay(5000);
}
assert.ok(toolStarted, 'timed out waiting for the DSH Bash tool call');

await delay(10_000);
const taskBeforeRestart = await getTask(alphaCookie, runId);
assert.equal(taskBeforeRestart.status, 'working', 'task finished before the active restart could be tested');
const pidBefore = launchAgentPid();
log('api.restart.requested', { runId, activeStatus: taskBeforeRestart.status, apiPidBefore: pidBefore });
const restart = spawnSync('/bin/launchctl', ['kickstart', '-k', launchTarget], {
  encoding: 'utf8',
  timeout: 15_000,
  env: { HOME: process.env.HOME, PATH: process.env.PATH },
});
assert.equal(restart.status, 0, `API LaunchAgent restart returned ${restart.status ?? restart.error?.message}`);
restartIssued = true;
await waitForHealth();
log('api.restart.ready', { elapsedMs: Date.now() - startedAt, apiPidAfter: launchAgentPid() });

const completionDeadline = Date.now() + 15 * 60_000;
let completedTask;
while (Date.now() < completionDeadline) {
  completedTask = await getTask(alphaCookie, runId);
  const traces = (completedTask.events || []).filter(event => event.type === 'debug').map(event => event.payload || {});
  const recovered = traces.some(event => event.stage === 'guest.pty.reconnect.complete');
  if (completedTask.status === 'done') {
    assert.ok(recovered, 'task completed but the API did not record a guest PTY recovery event');
    break;
  }
  if (['failed', 'waiting_for_user'].includes(completedTask.status)) {
    throw new Error(`task reached ${completedTask.status} after API restart`);
  }
  await delay(5000);
}
assert.equal(completedTask?.status, 'done', 'task did not finish before the recovery deadline');

const downloadPath = `/api/tasks/${encodeURIComponent(runId)}/artifacts/download?path=${encodeURIComponent(fileName)}`;
const artifactResponse = await fetch(baseUrl + downloadPath, { headers: { cookie: alphaCookie }, signal: AbortSignal.timeout(20_000) });
assert.equal(artifactResponse.status, 200, `owner artifact download returned HTTP ${artifactResponse.status}`);
const artifact = await artifactResponse.text();
assert.equal(artifact, `started ${marker}\nresumed ${marker}\n`);
const betaCrossTenant = await fetchJson(`/api/tasks/${encodeURIComponent(runId)}/artifacts`, {}, betaCookie);
assert.equal(betaCrossTenant.response.status, 404, 'Beta must not list Alpha artifacts');
const traces = (completedTask.events || []).filter(event => event.type === 'debug').map(event => event.payload || {});
const reattachCount = traces.filter(event => event.stage === 'guest.pty.reconnect.complete').length;
const harnessLaunchCount = traces.filter(event => event.stage === 'harness.launch').length;
assert.equal(reattachCount, 1);
assert.equal(harnessLaunchCount, 1, 'the same DSH task must not be launched twice');
log('active.dsh.recovery.passed', {
  runId,
  fileName,
  status: completedTask.status,
  apiRestarted: restartIssued,
  reattachCount,
  harnessLaunchCount,
  ownerArtifactHttp: artifactResponse.status,
  artifactMatches: true,
  betaArtifactHttp: betaCrossTenant.response.status,
  totalElapsedMs: Date.now() - startedAt,
});
