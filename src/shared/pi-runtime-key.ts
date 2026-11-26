import { createHash } from 'node:crypto';

export interface PiRuntimeKeyInput {
  packageJson: string;
  packageLock: string;
  runtimeManifest: string;
  bundleBuilder: string;
  runtimeSource: string;
  computerPlugin: string;
}

export function createPiRuntimeKey(input: PiRuntimeKeyInput): string {
  return createHash('sha256')
    .update(input.packageJson).update('\0')
    .update(input.packageLock).update('\0')
    .update(input.runtimeManifest).update('\0')
    .update(input.bundleBuilder).update('\0')
    .update(input.runtimeSource).update('\0')
    .update(input.computerPlugin)
    .digest('hex');
}
