import type { ProactiveMode } from '../shared/proactive.ts';

export const minimumProactiveIntervalMinutes = 1;
export const maximumProactiveIntervalMinutes = 10_080;
export const maximumProactiveRulesPerScan = 50;

export interface NormalizedProactiveRuleInput {
  name: string;
  prompt: string;
  intervalMinutes: number;
  mode: ProactiveMode;
}

export function normalizeProactiveRuleInput(input: {
  name?: unknown;
  prompt?: unknown;
  intervalMinutes?: unknown;
  mode?: unknown;
}, previous?: NormalizedProactiveRuleInput): NormalizedProactiveRuleInput {
  const name = typeof input.name === 'string' ? input.name.trim() : previous?.name || '';
  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : previous?.prompt || '';
  const rawInterval = input.intervalMinutes === undefined ? previous?.intervalMinutes : input.intervalMinutes;
  const intervalMinutes = typeof rawInterval === 'number' && Number.isSafeInteger(rawInterval) ? rawInterval : Number(rawInterval);
  const rawMode = input.mode === undefined ? previous?.mode : input.mode;
  const mode = rawMode === undefined ? 'observe' : rawMode;

  if (!name || name.length > 120) throw new Error('规则名称必须为 1 到 120 个字符。');
  if (!prompt || prompt.length > 10_000) throw new Error('规则任务必须为 1 到 10000 个字符。');
  if (!Number.isSafeInteger(intervalMinutes) || intervalMinutes < minimumProactiveIntervalMinutes || intervalMinutes > maximumProactiveIntervalMinutes) {
    throw new Error(`触发间隔必须为 ${minimumProactiveIntervalMinutes} 到 ${maximumProactiveIntervalMinutes} 分钟。`);
  }
  if (mode !== 'observe' && mode !== 'active') throw new Error('规则模式必须是 observe 或 active。');
  return { name, prompt, intervalMinutes, mode };
}

export function nextScheduledAt(scheduledAt: Date, intervalMinutes: number, now = new Date()): Date {
  if (!Number.isFinite(scheduledAt.getTime()) || !Number.isSafeInteger(intervalMinutes) || intervalMinutes < 1) {
    throw new Error('Scheduled time or interval is invalid.');
  }
  const intervalMs = intervalMinutes * 60_000;
  let next = scheduledAt.getTime() + intervalMs;
  if (next <= now.getTime()) {
    const missedIntervals = Math.floor((now.getTime() - next) / intervalMs) + 1;
    next += missedIntervals * intervalMs;
  }
  return new Date(next);
}
