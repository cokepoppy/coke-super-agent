export type RunStatus = 'queued' | 'working' | 'waiting_for_user' | 'done' | 'failed' | 'stopped';
export type RunEventType = 'queued' | 'progress' | 'waiting_for_user' | 'completed' | 'failed' | 'stopped';
export type ComputerState = 'not_created' | 'creating' | 'running' | 'paused' | 'failed';
export type DesktopState = 'pending' | 'installing' | 'ready' | 'failed';

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
