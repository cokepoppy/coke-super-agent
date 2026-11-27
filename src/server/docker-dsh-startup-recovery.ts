export interface DockerDshStartupEvidence<T> {
  state: T | null;
  processExists: boolean;
}

export async function waitForDockerDshStartupEvidence<T>(options: {
  readState(): Promise<T | null>;
  processExists(): Promise<boolean>;
  assertLease(): Promise<void>;
  delay(ms: number): Promise<void>;
  timeoutMs: number;
  pollMs?: number;
}): Promise<DockerDshStartupEvidence<T>> {
  const deadline = Date.now() + Math.max(0, options.timeoutMs);
  const pollMs = Math.max(1, options.pollMs ?? 500);
  while (true) {
    await options.assertLease();
    const state = await options.readState();
    const processExists = await options.processExists();
    if (state || processExists) return { state, processExists };
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return { state: null, processExists: false };
    await options.delay(Math.min(pollMs, remainingMs));
  }
}
