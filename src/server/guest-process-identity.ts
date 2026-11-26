const dshRuntimeEntry = '/opt/csa-agent-runtime/dsh-sdk-client/dist/run-task.bundle.mjs';
const piRuntimeEntry = /^\/opt\/csa-agent-runtime\/pi-[a-f0-9]{16}\/run-task\.mjs$/;

export function isGuestAgentProcessCommandLine(cmdline: string, runId: string): boolean {
  if (!runId) return false;
  const args = cmdline.split('\0').filter(Boolean);
  if (!args.includes(runId)) return false;
  return args.includes(dshRuntimeEntry) || args.some(argument => piRuntimeEntry.test(argument));
}
