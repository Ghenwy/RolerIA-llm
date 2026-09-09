/** SOT-06: canonical HP thresholds. Stabilization and special creatures are not inferred. */
export function healthStateForHitPoints(hp: number): 'alive' | 'disabled' | 'dying' | 'dead' | undefined {
  if (!Number.isSafeInteger(hp)) return undefined;
  return hp > 0 ? 'alive' : hp === 0 ? 'disabled' : hp >= -9 ? 'dying' : 'dead';
}
