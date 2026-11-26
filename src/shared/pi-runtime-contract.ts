const packageName = '@mariozechner/pi-coding-agent';
const packageVersion = '0.73.1';
const apiProtocol = 'openai-completions';

export function hasSupportedPiRuntimeContract(packageJsonText: string, runtimeManifestText: string): boolean {
  try {
    const packageJson = JSON.parse(packageJsonText) as { dependencies?: Record<string, unknown> };
    const manifest = JSON.parse(runtimeManifestText) as {
      package?: unknown;
      version?: unknown;
      apiProtocol?: unknown;
    };
    return packageJson.dependencies?.[packageName] === packageVersion
      && manifest.package === packageName
      && manifest.version === packageVersion
      && manifest.apiProtocol === apiProtocol;
  } catch {
    return false;
  }
}
