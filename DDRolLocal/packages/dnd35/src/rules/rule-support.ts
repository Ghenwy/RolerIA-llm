import { err, ok, type Result } from '@nyx/domain';

export type DndRuleError = {
  readonly code:
    | 'ACTION_BUDGET_EXCEEDED'
    | 'ARITHMETIC_OVERFLOW'
    | 'INVALID_CHARGE'
    | 'INVALID_RULE_INPUT'
    | 'MOVEMENT_CONFLICT'
    | 'POWER_POINT_LIMIT'
    | 'PRESTIGE_PREREQUISITES_NOT_MET'
    | 'UNJUSTIFIED_COVER';
  readonly message: string;
};

export const ruleError = (code: DndRuleError['code'], message: string): Result<never, DndRuleError> =>
  err({ code, message });

export const isSafeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value);

export const isNonNegativeSafeInteger = (value: unknown): value is number =>
  isSafeInteger(value) && value >= 0;

export function safeRuleSum(values: readonly number[]): Result<number, DndRuleError> {
  if (!values.every(isSafeInteger)) return ruleError('INVALID_RULE_INPUT', 'Todos los términos deben ser enteros seguros.');
  let total = 0;
  for (const value of values) {
    total += value;
    if (!Number.isSafeInteger(total)) return ruleError('ARITHMETIC_OVERFLOW', 'La suma excede el rango entero seguro.');
  }
  return ok(total);
}
