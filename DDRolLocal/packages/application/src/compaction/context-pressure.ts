export const CONTEXT_PRESSURE_LIMITS = Object.freeze({
  yellow: 72_000,
  orange: 80_000,
  red: 88_000,
  critical: 96_000,
  targetMin: 52_000,
  targetMax: 62_000
});

export type ContextPressureState = 'GREEN' | 'YELLOW' | 'ORANGE' | 'RED' | 'CRITICAL';

export type ContextPressureAction =
  | 'NONE'
  | 'PREPARE_COMPACTION'
  | 'COMPACT_AFTER_RESPONSE'
  | 'COMPACT_BEFORE_COMPLEX_TURN'
  | 'BLOCK_AND_COMPACT';

export interface ContextPressureDecision {
  readonly inputTokens: number;
  readonly state: ContextPressureState;
  readonly action: ContextPressureAction;
  readonly blocksExpansion: boolean;
  readonly target: Readonly<{ min: number; max: number }>;
}

export function classifyContextPressure(inputTokens: number): ContextPressureDecision {
  if (!Number.isSafeInteger(inputTokens) || inputTokens < 0) {
    throw new RangeError('inputTokens must be a non-negative safe integer');
  }

  const target = Object.freeze({ min: CONTEXT_PRESSURE_LIMITS.targetMin, max: CONTEXT_PRESSURE_LIMITS.targetMax });
  if (inputTokens > CONTEXT_PRESSURE_LIMITS.critical) {
    return Object.freeze({ inputTokens, state: 'CRITICAL', action: 'BLOCK_AND_COMPACT', blocksExpansion: true, target });
  }
  if (inputTokens > CONTEXT_PRESSURE_LIMITS.red) {
    return Object.freeze({ inputTokens, state: 'RED', action: 'COMPACT_BEFORE_COMPLEX_TURN', blocksExpansion: false, target });
  }
  if (inputTokens > CONTEXT_PRESSURE_LIMITS.orange) {
    return Object.freeze({ inputTokens, state: 'ORANGE', action: 'COMPACT_AFTER_RESPONSE', blocksExpansion: false, target });
  }
  if (inputTokens >= CONTEXT_PRESSURE_LIMITS.yellow) {
    return Object.freeze({ inputTokens, state: 'YELLOW', action: 'PREPARE_COMPACTION', blocksExpansion: false, target });
  }
  return Object.freeze({ inputTokens, state: 'GREEN', action: 'NONE', blocksExpansion: false, target });
}
