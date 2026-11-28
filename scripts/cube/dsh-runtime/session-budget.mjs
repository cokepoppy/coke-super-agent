export const maxSessionRunDurationMs = 25 * 60_000;

// A useful browser or file-generation task often needs more than twenty
// Harness reasoning cycles. Keep a hard ceiling while leaving room for a
// complete create, inspect, and verify loop.
export const maxSessionRunSteps = 40;
