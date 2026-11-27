/**
 * noVNC treats its `path` option as a relative path and prepends `/` itself.
 * Passing an app path with a leading slash creates a `//...` WebSocket URL.
 */
export function noVncWebSocketPath(appPath: string): string {
  return appPath.replace(/^\/+/, '');
}
