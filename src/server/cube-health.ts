export interface CubeApiProbeResult {
  checked: boolean;
  reachable: boolean | null;
  httpStatus: number | null;
  durationMs: number;
  errorName?: string;
  errorCode?: string;
}

export async function probeCubeApi(apiUrl: string, timeoutMs = 1500): Promise<CubeApiProbeResult> {
  const startedAt = Date.now();
  if (!apiUrl) return { checked: false, reachable: null, httpStatus: null, durationMs: 0 };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(new URL('/health', apiUrl), { signal: controller.signal });
    return { checked: true, reachable: response.ok, httpStatus: response.status, durationMs: Date.now() - startedAt };
  } catch (error) {
    const value = error instanceof Error ? error : new Error(String(error));
    const cause = value.cause && typeof value.cause === 'object' ? value.cause as { code?: unknown } : undefined;
    return {
      checked: true,
      reachable: false,
      httpStatus: null,
      durationMs: Date.now() - startedAt,
      errorName: value.name || 'Error',
      ...(typeof cause?.code === 'string' ? { errorCode: cause.code } : {}),
    };
  } finally {
    clearTimeout(timeout);
  }
}
