import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { config } from './config.ts';

const execFileAsync = promisify(execFile);
const workspaceRoot = '/data/shared/csa-tenant-workspaces';
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export class TenantWorkspaceConfigurationError extends Error {}
export type TenantHostMount = { hostPath: string; mountPath: '/workspace'; readOnly: false };

export async function provisionTenantWorkspace(tenantId: string): Promise<TenantHostMount> {
  if (!uuidPattern.test(tenantId)) throw new Error('Invalid internal tenant ID for workspace provisioning.');
  if (config.cube.workspaceMode !== 'lima') {
    throw new TenantWorkspaceConfigurationError('租户持久工作区尚未配置，请先准备 Cube 节点的 XFS 工作区挂载。');
  }
  const hostPath = `${workspaceRoot}/${tenantId}`;
  const result = await execFileAsync(config.cube.limaCommand, [
    'shell', 'cube-node', '--', 'sudo', '-n', '/usr/local/sbin/csa-ensure-tenant-workspace', tenantId,
  ], {
    env: { PATH: process.env.PATH, HOME: homedir(), LIMA_HOME: config.cube.limaHome },
    timeout: 30_000,
    maxBuffer: 16 * 1024,
    encoding: 'utf8',
  });
  if (result.stdout.trim() !== hostPath) throw new Error('Cube node returned an unexpected tenant workspace path.');
  return { hostPath, mountPath: '/workspace', readOnly: false };
}
