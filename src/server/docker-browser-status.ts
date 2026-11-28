import type { BrowserState } from '../shared/types.ts';

export function resolveDockerBrowserStatus(rawStatus: string, sessionReady: boolean, cdpReady: boolean): BrowserState {
  const status = rawStatus.trim().slice(0, 16);
  if (status === 'failed') return 'failed';
  // Older desktop base images do not write browser.status. A live CDP response
  // is stronger evidence than that optional marker and means Browser Use is ready.
  if (cdpReady) return 'ready';
  if (status === 'starting' || sessionReady) return 'starting';
  return 'unknown';
}
