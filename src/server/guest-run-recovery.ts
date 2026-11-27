export interface GuestRunRecoveryState {
  status?: string;
}

export type GuestRunRecoveryDecision = 'launch' | 'resume' | 'persist-terminal' | 'fail-closed';

export function classifyGuestRunRecovery(
  state: GuestRunRecoveryState | null,
  launcherMarkerExists: boolean,
): GuestRunRecoveryDecision {
  if (!state) return launcherMarkerExists ? 'fail-closed' : 'launch';
  if (state.status === 'done' || state.status === 'failed' || state.status === 'waiting_for_user') {
    return 'persist-terminal';
  }
  if (state.status === 'working') return 'resume';
  return 'fail-closed';
}
