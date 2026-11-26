export type RunStatus = 'queued' | 'working' | 'waiting_for_user' | 'done' | 'failed' | 'stopped';
export type RunEventType = 'queued' | 'progress' | 'debug' | 'waiting_for_user' | 'completed' | 'failed' | 'stopped';
export type RunTraceLevel = 'info' | 'warning' | 'error';

export interface RunTraceEvent {
  component: string;
  stage: string;
  level: RunTraceLevel;
  message: string;
  durationMs?: number;
  details?: Record<string, string | number | boolean | null>;
}
export type ComputerState = 'not_created' | 'creating' | 'running' | 'paused' | 'failed';
export type DesktopState = 'pending' | 'installing' | 'ready' | 'failed';
export type BrowserState = 'unavailable' | 'starting' | 'ready' | 'failed' | 'unknown';

export interface ComputerView {
  state: ComputerState;
  desktopState: DesktopState;
  updatedAt: string;
}

export interface SessionView {
  user: { id: string; username: string; displayName: string };
  tenant: { id: string; slug: string; displayName: string };
}

export interface RunSummary {
  id: string;
  threadId: string;
  title: string;
  prompt: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
}

export interface RunEventView {
  id: number;
  sequence: number;
  type: RunEventType | string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface RunDetail extends RunSummary {
  events: RunEventView[];
}

export interface ActivityFeedItem {
  runId: string;
  title: string;
  status: RunStatus;
  event: RunEventView;
}

export interface TaskArtifact {
  path: string;
  name: string;
  sizeBytes: number;
  modifiedAt: string | null;
  mediaType: string;
  previewable: boolean;
}
