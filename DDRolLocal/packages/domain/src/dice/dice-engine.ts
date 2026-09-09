import { err, ok, type Result } from '../result.js';
import type { DiceState } from '../state/types.js';
import { PythonRandom } from './python-random.js';
import { sha256Bytes } from './sha256.js';

export interface DiceRollRecord {
  algorithm: DiceState['algorithm'];
  campaign_seed: string;
  roll_index: number;
  expression: string;
  count: number;
  sides: number;
  modifier: number;
  rolls: number[];
  total: number;
}

export type DiceErrorCode = 'INVALID_DICE_STATE' | 'INVALID_DICE_EXPRESSION' | 'DICE_LIMIT_EXCEEDED';

export interface DiceError {
  code: DiceErrorCode;
  message: string;
}

export interface DiceRollResult {
  record: DiceRollRecord;
  next_rng: DiceState;
}

export class DiceEngine {
  roll(state: DiceState, expression: string): Result<DiceRollResult, DiceError> {
    if (
      state.algorithm !== 'sha256-seeded-python-random' ||
      state.campaign_seed.length === 0 ||
      !Number.isSafeInteger(state.roll_index) ||
      state.roll_index < 0
    ) {
      return err({ code: 'INVALID_DICE_STATE', message: 'El estado RNG no es válido.' });
    }
    const match = /^([1-9]\d*)d([1-9]\d*)([+-]\d+)?$/.exec(expression);
    if (!match) return err({ code: 'INVALID_DICE_EXPRESSION', message: 'La expresión debe usar NdS o NdS±M.' });
    const count = Number(match[1]);
    const sides = Number(match[2]);
    const modifier = match[3] ? Number(match[3]) : 0;
    if (count > 1000 || sides < 2 || sides > 1_000_000 || !Number.isSafeInteger(modifier)) {
      return err({ code: 'DICE_LIMIT_EXCEEDED', message: 'La expresión excede los límites mecánicos del Dice Engine.' });
    }

    const material = `${state.campaign_seed}:${state.roll_index}:${count}d${sides}`;
    const random = new PythonRandom(sha256Bytes(material));
    const rolls = Array.from({ length: count }, () => random.randBelow(sides) + 1);
    const total = rolls.reduce((sum, value) => sum + value, modifier);
    return ok({
      record: {
        algorithm: state.algorithm,
        campaign_seed: state.campaign_seed,
        roll_index: state.roll_index,
        expression,
        count,
        sides,
        modifier,
        rolls,
        total
      },
      next_rng: { ...state, roll_index: state.roll_index + 1 }
    });
  }
}
