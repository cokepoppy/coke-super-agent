export type ProactiveMode = 'observe' | 'active';
export type ProactiveOccurrenceOutcome = 'observed' | 'queued' | 'skipped_busy';

export interface ProactiveRuleView {
  id: string;
  name: string;
  prompt: string;
  intervalMinutes: number;
  mode: ProactiveMode;
  enabled: boolean;
  nextRunAt: string;
  lastTriggeredAt: string | null;
  lastOutcome: ProactiveOccurrenceOutcome | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProactiveOccurrenceView {
  id: string;
  ruleId: string;
  ruleName: string;
  scheduledFor: string;
  outcome: ProactiveOccurrenceOutcome;
  runId: string | null;
  createdAt: string;
}

export interface ProactiveTicketContext {
  ticketId: string;
  ruleId: string;
  ruleName: string;
  mandate: string;
  source: 'schedule';
  scheduledFor: string;
}

export interface CreateProactiveRuleInput {
  name?: unknown;
  prompt?: unknown;
  intervalMinutes?: unknown;
  mode?: unknown;
}

export interface PatchProactiveRuleInput {
  name?: unknown;
  prompt?: unknown;
  intervalMinutes?: unknown;
  mode?: unknown;
  enabled?: unknown;
}
