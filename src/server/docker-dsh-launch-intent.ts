// Arguments are passed separately to sh; no task or tenant value is evaluated
// as shell source. noclobber gives the persistent run exactly one claimant.
export const claimDockerDshLaunchIntentScript = `set -eu
umask 077
/bin/mkdir -p -- "$1"
if (set -C; printf '%s\\n' "$2" > "$1/launch.intent") 2>/dev/null; then
  printf created
elif [ -e "$1/launch.intent" ]; then
  printf exists
else
  exit 1
fi`;

export class DockerDshRecoveryPendingError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DockerDshRecoveryPendingError';
  }
}

// A claim precedes any input writes, so a second worker cannot overwrite the
// first worker's input. Once a start is submitted its outcome may be unknown:
// the persistent claim is retained and must be reconciled, never replayed.
export async function claimAndStartDockerDsh(options: {
  lease: { assertOwned(): Promise<void> };
  claim(): Promise<boolean>;
  writeInput(): Promise<void>;
  start(): Promise<void>;
  isStopped(): boolean;
}): Promise<boolean> {
  await options.lease.assertOwned();
  if (options.isStopped()) return false;
  let claimed: boolean;
  try { claimed = await options.claim(); }
  catch (error) { throw new DockerDshRecoveryPendingError('Docker DSH 启动意图的写入结果不明。', { cause: error }); }
  if (!claimed) throw new DockerDshRecoveryPendingError('另一执行者已为该 Docker DSH 任务写入启动意图。');
  await options.lease.assertOwned();
  if (options.isStopped()) return false;
  await options.writeInput();
  await options.lease.assertOwned();
  if (options.isStopped()) return false;
  try { await options.start(); }
  catch (error) { throw new DockerDshRecoveryPendingError('Docker DSH 启动请求结果不明。', { cause: error }); }
  return true;
}
