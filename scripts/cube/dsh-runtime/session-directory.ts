import { isAbsolute, join, resolve, sep } from 'node:path';

/**
 * DSH places session files below `sessions/--<cwd-with-slashes-as-dashes>--/<id>`.
 * The SDK workspace must match the actual process cwd; using a hard-coded
 * `/workspace` path makes existing Docker sessions look new and then fail on
 * `harness.session(id)` with "session already exists".
 */
export function dshSessionDirectory(dshHome: string, workspace: string, sessionId: string): string {
  if (!isAbsolute(workspace)) throw new Error('DSH workspace must be an absolute path.');
  const workspaceKey = resolve(workspace).split(sep).filter(Boolean).join('-');
  if (!workspaceKey || !/^[0-9a-f-]{36}$/i.test(sessionId)) throw new Error('DSH session identity is invalid.');
  return join(dshHome, 'sessions', `--${workspaceKey}--`, sessionId);
}
