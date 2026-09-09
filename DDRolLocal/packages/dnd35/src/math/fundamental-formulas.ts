import type { DiceEngine, DiceRollRecord, DiceState } from '@nyx/domain';
import { err, ok, type Result } from '@nyx/domain';

type DicePort = Pick<DiceEngine, 'roll'>;

export type DndMathError = {
  readonly code: 'ARITHMETIC_OVERFLOW' | 'DICE_ERROR' | 'INVALID_INITIATIVE' | 'INVALID_MATH_INPUT';
  readonly message: string;
};

type D20Resolution = {
  readonly natural_roll: number;
  readonly total: number;
  readonly roll_record: DiceRollRecord;
  readonly next_rng: DiceState;
};

type CheckResolution = D20Resolution & {
  readonly dc: number;
  readonly succeeds: boolean;
  readonly automatic: boolean;
};

function safeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return safeInteger(value) && value >= 0;
}

function validIntegerList(value: unknown): value is readonly number[] {
  return Array.isArray(value) && value.every(safeInteger);
}

function safeSum(values: readonly number[]): Result<number, DndMathError> {
  if (!values.every(safeInteger)) {
    return err({ code: 'INVALID_MATH_INPUT', message: 'Todos los términos deben ser enteros seguros.' });
  }
  let total = 0;
  for (const value of values) {
    total += value;
    if (!Number.isSafeInteger(total)) {
      return err({ code: 'ARITHMETIC_OVERFLOW', message: 'Una suma intermedia excede el rango entero seguro.' });
    }
  }
  return ok(total);
}

function rollD20(
  dice: DicePort,
  rng: DiceState
): Result<Omit<D20Resolution, 'total'>, DndMathError> {
  const rolled = dice.roll(rng, '1d20');
  if (!rolled.ok) {
    return err({ code: 'DICE_ERROR', message: rolled.error.message });
  }
  const naturalRoll = rolled.value.record.rolls[0];
  if (naturalRoll === undefined) {
    return err({ code: 'DICE_ERROR', message: 'DiceEngine no devolvió el d20 solicitado.' });
  }
  return ok({
    natural_roll: naturalRoll,
    roll_record: rolled.value.record,
    next_rng: rolled.value.next_rng
  });
}

export function abilityModifier(abilityScore: number): Result<number, DndMathError> {
  if (!nonNegativeSafeInteger(abilityScore)) {
    return err({ code: 'INVALID_MATH_INPUT', message: 'ability_score debe ser entero seguro no negativo.' });
  }
  return ok(Math.floor((abilityScore - 10) / 2));
}

export type GeneralCheckInput = {
  readonly ability_modifier: number;
  readonly ranks: number;
  readonly typed_modifiers: readonly number[];
  readonly untyped_modifiers: readonly number[];
  readonly dc: number;
};

export function resolveGeneralCheck(
  dice: DicePort,
  rng: DiceState,
  input: GeneralCheckInput
): Result<CheckResolution, DndMathError> {
  if (!safeInteger(input.ability_modifier)
    || !nonNegativeSafeInteger(input.ranks)
    || !validIntegerList(input.typed_modifiers)
    || !validIntegerList(input.untyped_modifiers)
    || !nonNegativeSafeInteger(input.dc)) {
    return err({ code: 'INVALID_MATH_INPUT', message: 'Los términos de la prueba general no son válidos.' });
  }
  const rolled = rollD20(dice, rng);
  if (!rolled.ok) return rolled;
  const total = safeSum([
    rolled.value.natural_roll,
    input.ability_modifier,
    input.ranks,
    ...input.typed_modifiers,
    ...input.untyped_modifiers
  ]);
  if (!total.ok) return total;
  return ok({
    ...rolled.value,
    total: total.value,
    dc: input.dc,
    succeeds: total.value >= input.dc,
    automatic: false
  });
}

export type SavingThrowInput = {
  readonly base_save: number;
  readonly ability_modifier: number;
  readonly modifiers: readonly number[];
  readonly dc: number;
};

export function resolveSavingThrow(
  dice: DicePort,
  rng: DiceState,
  input: SavingThrowInput
): Result<CheckResolution, DndMathError> {
  if (!safeInteger(input.base_save)
    || !safeInteger(input.ability_modifier)
    || !validIntegerList(input.modifiers)
    || !nonNegativeSafeInteger(input.dc)) {
    return err({ code: 'INVALID_MATH_INPUT', message: 'Los términos de la salvación no son válidos.' });
  }
  const rolled = rollD20(dice, rng);
  if (!rolled.ok) return rolled;
  const total = safeSum([
    rolled.value.natural_roll,
    input.base_save,
    input.ability_modifier,
    ...input.modifiers
  ]);
  if (!total.ok) return total;
  const automatic = rolled.value.natural_roll === 1 || rolled.value.natural_roll === 20;
  const succeeds = rolled.value.natural_roll === 20
    || (rolled.value.natural_roll !== 1 && total.value >= input.dc);
  return ok({ ...rolled.value, total: total.value, dc: input.dc, succeeds, automatic });
}

export type AttackInput = {
  readonly attack_kind: 'MELEE' | 'RANGED';
  readonly base_attack_bonus: number;
  readonly strength_modifier: number;
  readonly dexterity_modifier: number;
  readonly size_modifier: number;
  readonly modifiers: readonly number[];
  readonly armor_class: number;
};

export type AttackResolution = D20Resolution & {
  readonly attack_kind: AttackInput['attack_kind'];
  readonly ability_source: 'STRENGTH' | 'DEXTERITY';
  readonly armor_class: number;
  readonly hits: boolean;
  readonly critical_threat: boolean;
  readonly requires_confirmation: boolean;
};

export function resolveAttack(
  dice: DicePort,
  rng: DiceState,
  input: AttackInput
): Result<AttackResolution, DndMathError> {
  if ((input.attack_kind !== 'MELEE' && input.attack_kind !== 'RANGED')
    || !safeInteger(input.base_attack_bonus)
    || !safeInteger(input.strength_modifier)
    || !safeInteger(input.dexterity_modifier)
    || !safeInteger(input.size_modifier)
    || !validIntegerList(input.modifiers)
    || !safeInteger(input.armor_class)) {
    return err({ code: 'INVALID_MATH_INPUT', message: 'Los términos del ataque no son válidos.' });
  }
  const rolled = rollD20(dice, rng);
  if (!rolled.ok) return rolled;
  const abilitySource = input.attack_kind === 'MELEE' ? 'STRENGTH' : 'DEXTERITY';
  const abilityModifier = abilitySource === 'STRENGTH'
    ? input.strength_modifier
    : input.dexterity_modifier;
  const total = safeSum([
    rolled.value.natural_roll,
    input.base_attack_bonus,
    abilityModifier,
    input.size_modifier,
    ...input.modifiers
  ]);
  if (!total.ok) return total;
  const criticalThreat = rolled.value.natural_roll === 20;
  const hits = criticalThreat
    || (rolled.value.natural_roll !== 1 && total.value >= input.armor_class);
  return ok({
    ...rolled.value,
    total: total.value,
    attack_kind: input.attack_kind,
    ability_source: abilitySource,
    armor_class: input.armor_class,
    hits,
    critical_threat: criticalThreat,
    requires_confirmation: criticalThreat
  });
}

export type ArmorClassInput = {
  readonly armor: number;
  readonly shield: number;
  readonly dexterity_modifier: number;
  readonly size_modifier: number;
  readonly natural_armor: number;
  readonly deflection: number;
  readonly dodge: number;
  readonly other_modifiers: number;
  readonly modifiers_lost_when_dex_denied: number;
};

export type ArmorClasses = {
  readonly armor_class: number;
  readonly touch_armor_class: number;
  readonly flat_footed_armor_class: number;
};

const ARMOR_CLASS_KEYS = new Set<keyof ArmorClassInput>([
  'armor',
  'shield',
  'dexterity_modifier',
  'size_modifier',
  'natural_armor',
  'deflection',
  'dodge',
  'other_modifiers',
  'modifiers_lost_when_dex_denied'
]);

export function calculateArmorClasses(input: ArmorClassInput): Result<ArmorClasses, DndMathError> {
  const keys = Object.keys(input);
  const values = [
    input.armor,
    input.shield,
    input.dexterity_modifier,
    input.size_modifier,
    input.natural_armor,
    input.deflection,
    input.dodge,
    input.other_modifiers,
    input.modifiers_lost_when_dex_denied
  ];
  if (keys.length !== ARMOR_CLASS_KEYS.size
    || keys.some(key => !ARMOR_CLASS_KEYS.has(key as keyof ArmorClassInput))
    || !values.every(safeInteger)
    || [
      input.armor,
      input.shield,
      input.natural_armor,
      input.deflection,
      input.dodge,
      input.modifiers_lost_when_dex_denied
    ].some(value => value < 0)) {
    return err({ code: 'INVALID_MATH_INPUT', message: 'Todos los componentes de CA deben ser enteros seguros.' });
  }
  const normal = safeSum([10, ...values]);
  const touch = safeSum([
    10,
    input.dexterity_modifier,
    input.size_modifier,
    input.deflection,
    input.dodge,
    input.other_modifiers,
    input.modifiers_lost_when_dex_denied
  ]);
  if (!normal.ok) return err(normal.error);
  if (!touch.ok) return err(touch.error);
  const flatFooted = safeSum([
    normal.value,
    -Math.max(0, input.dexterity_modifier),
    -input.dodge,
    -input.modifiers_lost_when_dex_denied
  ]);
  if (!flatFooted.ok) return flatFooted;
  return ok({
    armor_class: normal.value,
    touch_armor_class: touch.value,
    flat_footed_armor_class: flatFooted.value
  });
}

export type InitiativeRoll = D20Resolution & {
  readonly initiative_modifier: number;
};

export type InitiativeInput = {
  readonly dexterity_modifier: number;
  readonly initiative_modifiers: readonly number[];
};

export function rollInitiative(
  dice: DicePort,
  rng: DiceState,
  input: InitiativeInput
): Result<InitiativeRoll, DndMathError> {
  if (!safeInteger(input.dexterity_modifier) || !validIntegerList(input.initiative_modifiers)) {
    return err({ code: 'INVALID_MATH_INPUT', message: 'Los términos de iniciativa no son válidos.' });
  }
  const initiativeModifier = safeSum([input.dexterity_modifier, ...input.initiative_modifiers]);
  if (!initiativeModifier.ok) {
    return initiativeModifier;
  }
  const rolled = rollD20(dice, rng);
  if (!rolled.ok) return rolled;
  const total = safeSum([rolled.value.natural_roll, initiativeModifier.value]);
  if (!total.ok) return total;
  return ok({ ...rolled.value, total: total.value, initiative_modifier: initiativeModifier.value });
}

export type InitiativeContestant = {
  readonly participant_id: string;
  readonly total: number;
  readonly initiative_modifier: number;
};

export type InitiativeTieInput = {
  readonly left: InitiativeContestant;
  readonly right: InitiativeContestant;
};

export type InitiativeTieResolution = {
  readonly winner_id: string;
  readonly tie_breaker: 'TOTAL' | 'MODIFIER' | 'DETERMINISTIC_RANDOM';
  readonly next_rng: DiceState;
  readonly roll_record?: DiceRollRecord;
};

export function breakInitiativeTie(
  dice: DicePort,
  rng: DiceState,
  input: InitiativeTieInput
): Result<InitiativeTieResolution, DndMathError> {
  const { left, right } = input;
  if (left.participant_id.length === 0
    || right.participant_id.length === 0
    || left.participant_id === right.participant_id
    || !safeInteger(left.total)
    || !safeInteger(right.total)
    || !safeInteger(left.initiative_modifier)
    || !safeInteger(right.initiative_modifier)) {
    return err({ code: 'INVALID_INITIATIVE', message: 'Los participantes de iniciativa no son válidos.' });
  }
  if (left.total !== right.total) {
    return ok({
      winner_id: left.total > right.total ? left.participant_id : right.participant_id,
      tie_breaker: 'TOTAL',
      next_rng: structuredClone(rng)
    });
  }
  if (left.initiative_modifier !== right.initiative_modifier) {
    return ok({
      winner_id: left.initiative_modifier > right.initiative_modifier ? left.participant_id : right.participant_id,
      tie_breaker: 'MODIFIER',
      next_rng: structuredClone(rng)
    });
  }
  const rolled = dice.roll(rng, '1d2');
  if (!rolled.ok) return err({ code: 'DICE_ERROR', message: rolled.error.message });
  const die = rolled.value.record.rolls[0];
  if (die === undefined) return err({ code: 'DICE_ERROR', message: 'DiceEngine no devolvió el desempate.' });
  return ok({
    winner_id: die === 1 ? left.participant_id : right.participant_id,
    tie_breaker: 'DETERMINISTIC_RANDOM',
    next_rng: rolled.value.next_rng,
    roll_record: rolled.value.record
  });
}

function saveDc(
  effectLevel: number,
  keyAbilityModifier: number,
  modifiers: readonly number[]
): Result<number, DndMathError> {
  if (!nonNegativeSafeInteger(effectLevel)
    || !safeInteger(keyAbilityModifier)
    || !validIntegerList(modifiers)) {
    return err({ code: 'INVALID_MATH_INPUT', message: 'Los términos de la CD no son válidos.' });
  }
  return safeSum([10, effectLevel, keyAbilityModifier, ...modifiers]);
}

export function spellSaveDc(
  spellLevel: number,
  keyAbilityModifier: number,
  modifiers: readonly number[]
): Result<number, DndMathError> {
  return saveDc(spellLevel, keyAbilityModifier, modifiers);
}

export function powerSaveDc(
  powerLevel: number,
  keyAbilityModifier: number,
  modifiers: readonly number[]
): Result<number, DndMathError> {
  return saveDc(powerLevel, keyAbilityModifier, modifiers);
}

type ResistanceInput = {
  readonly resistance: number;
};

function resolveResistance(
  dice: DicePort,
  rng: DiceState,
  qualifiedLevel: number,
  input: ResistanceInput
): Result<CheckResolution, DndMathError> {
  if (!nonNegativeSafeInteger(qualifiedLevel) || !nonNegativeSafeInteger(input.resistance)) {
    return err({ code: 'INVALID_MATH_INPUT', message: 'Nivel o resistencia no válidos.' });
  }
  const rolled = rollD20(dice, rng);
  if (!rolled.ok) return rolled;
  const total = safeSum([rolled.value.natural_roll, qualifiedLevel]);
  if (!total.ok) return total;
  return ok({
    ...rolled.value,
    total: total.value,
    dc: input.resistance,
    succeeds: total.value >= input.resistance,
    automatic: false
  });
}

export function resolveSpellResistance(
  dice: DicePort,
  rng: DiceState,
  input: ResistanceInput & { readonly caster_level: number }
): Result<CheckResolution, DndMathError> {
  return resolveResistance(dice, rng, input.caster_level, input);
}

export function resolvePowerResistance(
  dice: DicePort,
  rng: DiceState,
  input: ResistanceInput & { readonly manifester_level: number }
): Result<CheckResolution, DndMathError> {
  return resolveResistance(dice, rng, input.manifester_level, input);
}
