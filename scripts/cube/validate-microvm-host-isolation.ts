import 'dotenv/config';
import { randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { RowDataPacket } from 'mysql2/promise';
import { pool } from '../../src/server/db.ts';
import { config } from '../../src/server/config.ts';
import { connectTenantSandbox, cubeConfig } from '../../src/server/computer.ts';
import { runGuestPty } from '../../src/server/runtime-bundle.ts';

const tenantSlug = process.env.CSA_SECURITY_TEST_TENANT_SLUG || '';
if (!/^[a-z0-9-]{1,64}$/.test(tenantSlug)) throw new Error('Set CSA_SECURITY_TEST_TENANT_SLUG to an explicit local test tenant slug.');
if (config.mysql.host !== '127.0.0.1' || config.mysql.port !== 13306 || config.mysql.database !== 'coke_super_agent') {
  throw new Error('Refusing to run outside the local Coke Super Agent development MySQL instance.');
}
if (!['127.0.0.1', 'localhost', '::1'].includes(new URL(config.cube.apiUrl).hostname) || config.cube.workspaceMode !== 'lima') {
  throw new Error('Refusing to run unless Cube API and workspace are the local Lima development node.');
}
if (config.agent.dshPlacement !== 'docker') throw new Error('Expected DSH to remain in its Docker container.');

const runId = randomUUID();
const startedAt = Date.now();
const logDirectory = process.env.CSA_BUILD_LOG_DIR || join(homedir(), '.local/share/csa-cube-node/build-logs');
mkdirSync(logDirectory, { recursive: true, mode: 0o700 });
const logPath = join(logDirectory, `microvm-host-isolation-${new Date().toISOString().replace(/[:.]/g, '-')}-${runId}.jsonl`);
function log(stage: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ timestamp: new Date().toISOString(), runId, elapsedMs: Date.now() - startedAt, stage, ...fields }) + '\n';
  process.stdout.write(line);
  appendFileSync(logPath, line, { mode: 0o600 });
}
function nodeCommand(command: string): string {
  const result = spawnSync(config.cube.limaCommand, ['shell', 'cube-node', '--', 'bash', '-lc', command], {
    env: { ...process.env, LIMA_HOME: config.cube.limaHome }, encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`Cube node diagnostic command failed (${result.status ?? result.error?.message ?? 'unknown'}).`);
  return result.stdout.trim();
}

const [tenantRows] = await pool.execute<RowDataPacket[]>(
  `SELECT t.id AS tenant_id, c.sandbox_id, c.state, c.desktop_state, c.generation,
      (SELECT COUNT(*) FROM runs r WHERE r.tenant_id = t.id AND r.status IN ('queued','working')) AS active_runs
   FROM tenants t JOIN computers c ON c.tenant_id = t.id WHERE t.slug = ? LIMIT 1`,
  [tenantSlug],
);
const tenant = tenantRows[0];
if (!tenant?.sandbox_id || tenant.state !== 'running') throw new Error('Selected test tenant has no running Cube microVM.');
if (Number(tenant.active_runs) !== 0) throw new Error('Selected test tenant has active work; refusing to inspect during a task.');

const nodeAddresses = nodeCommand("ip -4 -o addr show dev eth0 | awk '{split($4,a,\"/\"); print a[1]; exit}'; ip -4 route show default | awk '{print $3; exit}'").split(/\s+/);
const nodeIp = nodeAddresses[0] || '';
const gatewayIp = nodeAddresses[1] || '';
if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(nodeIp) || !/^\d{1,3}(\.\d{1,3}){3}$/.test(gatewayIp)) {
  throw new Error('Could not identify the local Cube node and Lima gateway IPv4 addresses.');
}

const canaryPath = `/tmp/csa-microvm-host-canary-${runId.replaceAll('-', '').slice(0, 16)}`;
const canaryMarker = randomBytes(24).toString('hex');
let canaryCreated = false;
let sandbox: Awaited<ReturnType<typeof connectTenantSandbox>> | undefined;
let failed = false;
try {
  log('preflight.complete', {
    tenantSlug, tenantId: tenant.tenant_id, sandboxId: tenant.sandbox_id,
    state: tenant.state, desktopState: tenant.desktop_state, generation: tenant.generation,
    activeRuns: Number(tenant.active_runs), mysql: 'local-development', cubeNode: nodeIp, limaGateway: gatewayIp,
    cubeApiHost: new URL(config.cube.apiUrl).hostname, workspaceMode: config.cube.workspaceMode,
  });

  nodeCommand(`umask 077; printf '%s' '${canaryMarker}' > '${canaryPath}'; chmod 0666 '${canaryPath}'; test "$(cat '${canaryPath}')" = '${canaryMarker}'`);
  canaryCreated = true;
  log('host.canary.created', { boundary: 'Cube guest to Lima node', path: canaryPath, mode: '0666', content: 'random non-secret marker' });

  sandbox = await connectTenantSandbox(String(tenant.tenant_id));
  if (sandbox.sandboxId !== tenant.sandbox_id) throw new Error('Connected Cube sandbox does not match the tenant database record.');
  const guestProbe = String.raw`
import json, os, re, socket, subprocess
status = {}
try:
    lines = open('/proc/self/status', encoding='utf-8').read().splitlines()
    for key in ('Uid', 'Gid', 'CapEff', 'CapBnd', 'NoNewPrivs', 'Seccomp'):
        row = next((line for line in lines if line.startswith(key + ':')), '')
        if row: status[key] = row.split(':', 1)[1].strip()
except OSError:
    status['procStatus'] = 'unavailable'
namespaces = {}
for name in ('mnt', 'pid', 'user', 'net', 'uts', 'ipc'):
    try: namespaces[name] = os.readlink('/proc/self/ns/' + name)
    except OSError: namespaces[name] = 'unavailable'
special_mounts = []
try:
    for line in open('/proc/mounts', encoding='utf-8'):
        parts = line.split()
        if len(parts) >= 3 and re.search(r'virtiofs|9p|fuse|hostfs', parts[2], re.I):
            special_mounts.append({'target': parts[1], 'type': parts[2]})
except OSError:
    pass
sockets = [p for p in ('/var/run/docker.sock', '/run/docker.sock', '/run/containerd/containerd.sock', '/run/crio/crio.sock') if os.path.exists(p)]
devices = {}
for p in ('/dev/kvm', '/dev/fuse', '/dev/mem', '/dev/vhost-vsock'):
    try:
        st = os.stat(p)
        devices[p] = {'present': True, 'charDevice': os.path.exists(p) and __import__('stat').S_ISCHR(st.st_mode), 'readable': os.access(p, os.R_OK), 'writable': os.access(p, os.W_OK)}
    except OSError:
        devices[p] = {'present': False}
try:
    hypervisor = subprocess.run(['systemd-detect-virt', '--vm'], capture_output=True, text=True, timeout=2).stdout.strip() or 'unknown'
except (OSError, subprocess.SubprocessError):
    hypervisor = 'unknown'
try:
    with open('/dev/mem', 'rb', buffering=0) as memory_device:
        memory_device.read(1)
    devmem_read = 'success'
except OSError as error:
    devmem_read = type(error).__name__
path_meta = {}
for p in ('/Users', '/home/lima', '/mnt/host', '/host'):
    path_meta[p] = os.path.exists(p)
canary_path = os.environ['CSA_CANARY_PATH']
marker = os.environ['CSA_CANARY_MARKER']
canary = {'present': os.path.exists(canary_path), 'readable': False, 'matches': False, 'writable': False, 'writeAttempted': False}
if canary['present']:
    canary['readable'] = os.access(canary_path, os.R_OK)
    if canary['readable']:
        try: canary['matches'] = open(canary_path, encoding='ascii').read() == marker
        except OSError: pass
    canary['writable'] = os.access(canary_path, os.W_OK)
    if canary['matches'] and canary['writable']:
        canary['writeAttempted'] = True
        try:
            with open(canary_path, 'w', encoding='ascii') as f: f.write('guest-write-proof')
        except OSError: canary['writeAttempted'] = False
ports = (22, 80, 443, 8080, 8082, 8443, 9090, 9091, 15002, 3306, 6379, 8090)
hosts = {'cubeNode': os.environ['CSA_CUBE_NODE_IP'], 'limaGateway': os.environ['CSA_LIMA_GATEWAY_IP']}
tcp = {}
for label, host in hosts.items():
    for port in ports:
        sock = socket.socket()
        sock.settimeout(0.35)
        try:
            sock.connect((host, port))
            tcp[f'{label}:{port}'] = True
        except OSError:
            tcp[f'{label}:{port}'] = False
        finally:
            sock.close()
print('CSA_HOST_BOUNDARY_RESULT=' + json.dumps({
    'status': status, 'namespaces': namespaces, 'specialMounts': special_mounts,
    'hypervisor': hypervisor, 'guestDevMemRead': devmem_read,
    'hostSockets': sockets, 'guestDevices': devices, 'hostPathMetadata': path_meta,
    'hostCanary': canary, 'hostTcpConnects': [k for k,v in tcp.items() if v],
    'hostTcpProbeCount': len(tcp),
}, sort_keys=True), flush=True)
`;
  const result = await runGuestPty(sandbox, `python3 - <<'CSA_GUEST_PROBE'\n${guestProbe}\nCSA_GUEST_PROBE`, '/', {
    CSA_CANARY_PATH: canaryPath,
    CSA_CANARY_MARKER: canaryMarker,
    CSA_CUBE_NODE_IP: nodeIp,
    CSA_LIMA_GATEWAY_IP: gatewayIp,
  }, undefined, 60_000, 16_384);
  if (result.exitCode !== 0) throw new Error(`Guest isolation probe exited ${result.exitCode}.`);
  const resultLine = result.output.split(/\r?\n/).reverse().find(line => line.includes('CSA_HOST_BOUNDARY_RESULT='));
  const json = resultLine?.slice(resultLine.indexOf('CSA_HOST_BOUNDARY_RESULT=') + 'CSA_HOST_BOUNDARY_RESULT='.length).trim();
  if (!json) throw new Error('Guest isolation probe returned no structured result.');
  const findings = JSON.parse(json) as {
    hostCanary?: { present?: boolean; matches?: boolean; writeAttempted?: boolean };
    hostTcpConnects?: string[];
    hostSockets?: string[];
    [key: string]: unknown;
  };
  log('guest.probe.complete', findings);

  const hostAfter = nodeCommand(`if test -e '${canaryPath}'; then cat '${canaryPath}'; else printf missing; fi`);
  const canaryUnchanged = hostAfter === canaryMarker;
  log('host.canary.verify', { unchanged: canaryUnchanged, readableFromGuest: findings.hostCanary?.matches === true, guestWriteAttempted: findings.hostCanary?.writeAttempted === true });
  if (!canaryUnchanged) throw new Error('Guest probe changed or removed the Lima host canary.');
  const hostCanary = findings.hostCanary;
  const hostTcpConnects = findings.hostTcpConnects;
  const hostSockets = findings.hostSockets;
  if (hostCanary?.matches || (hostTcpConnects?.length || 0) > 0 || (hostSockets?.length || 0) > 0) {
    log('containment.finding', { hostCanaryRead: hostCanary?.matches === true, hostCanaryWriteAttempted: hostCanary?.writeAttempted === true, reachableHostTcpPorts: hostTcpConnects || [], visibleHostSockets: hostSockets || [] });
  } else {
    log('containment.probes.blocked', { hostCanaryUnavailable: hostCanary?.present !== true, reachableHostTcpPorts: 0, visibleHostSockets: hostSockets?.length || 0 });
  }
} catch (error) {
  failed = true;
  log('diagnostic.failed', { errorName: error instanceof Error ? error.name : 'Error', message: error instanceof Error ? error.message.slice(0, 500) : 'Unknown error' });
} finally {
  if (sandbox) sandbox.close();
  if (canaryCreated) {
    try {
      nodeCommand(`rm -f -- '${canaryPath}'; test ! -e '${canaryPath}'`);
      log('host.canary.cleaned', { path: canaryPath });
    } catch (error) {
      failed = true;
      log('host.canary.cleanup.failed', { path: canaryPath, errorName: error instanceof Error ? error.name : 'Error' });
    }
  }
  await pool.end();
  process.stdout.write(`diagnostic_log=${logPath}\n`);
}
if (failed) process.exitCode = 1;
