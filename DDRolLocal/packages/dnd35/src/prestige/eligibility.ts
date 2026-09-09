import type { Dnd35PrestigeClass } from '../catalogs/protected-catalog.js';

export type Dnd35Alignment =
  | 'lawful_good'
  | 'neutral_good'
  | 'chaotic_good'
  | 'lawful_neutral'
  | 'true_neutral'
  | 'chaotic_neutral'
  | 'lawful_evil'
  | 'neutral_evil'
  | 'chaotic_evil';

export type PrestigeSpecialEvidence = {
  readonly requirement: string;
  readonly evidenceId: string;
  readonly sourceRefs: readonly string[];
};

export type PrestigeEligibilityEvidence = {
  readonly alignment: Dnd35Alignment;
  readonly raceTags: readonly string[];
  readonly bab: number;
  readonly skills: Readonly<Record<string, number>>;
  readonly skillPatterns: readonly string[];
  readonly feats: readonly string[];
  readonly featPatterns: readonly string[];
  readonly languages: readonly string[];
  readonly proficiencies: readonly string[];
  readonly spellcastingEvidence: readonly string[];
  readonly psionicsEvidence: readonly string[];
  readonly specialEvidence: readonly PrestigeSpecialEvidence[];
  readonly prestigeLevels: Readonly<Record<string, number>>;
};

export type PrestigeEligibilityFailureCode =
  | 'ALIGNMENT_MISMATCH'
  | 'BAB_TOO_LOW'
  | 'FEAT_MISSING'
  | 'FEAT_PATTERN_MISSING'
  | 'LANGUAGE_MISSING'
  | 'LEVEL_OUT_OF_RANGE'
  | 'PREVIOUS_LEVEL_MISSING'
  | 'PROFICIENCY_MISSING'
  | 'PSIONICS_EVIDENCE_MISSING'
  | 'RACE_EXCLUDED'
  | 'RACE_REQUIREMENT_MISSING'
  | 'SKILL_PATTERN_MISSING'
  | 'SKILL_RANK_TOO_LOW'
  | 'SPECIAL_EVIDENCE_MISSING'
  | 'SPELLCASTING_EVIDENCE_MISSING';

export type PrestigeEligibilityFailure = {
  readonly code: PrestigeEligibilityFailureCode;
  readonly field: string;
  readonly requirement: string;
};

export type PrestigeEligibilityReport = {
  readonly prestigeId: string;
  readonly nextLevel: number;
  readonly eligible: boolean;
  readonly failures: readonly PrestigeEligibilityFailure[];
  readonly evidenceIds: readonly string[];
};

function alignmentMatches(actual: Dnd35Alignment, requirement: string): boolean {
  if (requirement === 'evil') return actual.endsWith('_evil');
  if (requirement === 'lawful') return actual.startsWith('lawful_');
  if (requirement === 'chaotic') return actual.startsWith('chaotic_');
  if (requirement === 'nonlawful') return !actual.startsWith('lawful_');
  if (requirement === 'nonchaotic') return !actual.startsWith('chaotic_');
  return actual === requirement;
}

function validSpecialEvidence(
  requirement: string,
  evidence: readonly PrestigeSpecialEvidence[]
): PrestigeSpecialEvidence | undefined {
  return evidence.find(item => item.requirement === requirement
    && item.evidenceId.length > 0
    && item.sourceRefs.length > 0
    && item.sourceRefs.every(ref => ref.length > 0));
}

export function evaluatePrestigeEligibility(
  prestige: Dnd35PrestigeClass,
  character: PrestigeEligibilityEvidence,
  nextLevel: number
): PrestigeEligibilityReport {
  const failures: PrestigeEligibilityFailure[] = [];
  const fail = (code: PrestigeEligibilityFailureCode, field: string, requirement: string): void => {
    failures.push({ code, field, requirement });
  };
  const requirements = prestige.requirements;
  const currentLevel = character.prestigeLevels[prestige.id] ?? 0;

  if (!Number.isSafeInteger(nextLevel) || nextLevel < 1 || nextLevel > prestige.levels) {
    fail('LEVEL_OUT_OF_RANGE', 'nextLevel', `1..${prestige.levels}`);
  } else if ((nextLevel === 1 && currentLevel !== 0)
    || (nextLevel > 1 && currentLevel !== nextLevel - 1)) {
    fail('PREVIOUS_LEVEL_MISSING', 'prestigeLevels', `${prestige.id}=${nextLevel - 1}`);
  }

  if (requirements.alignment !== undefined && !alignmentMatches(character.alignment, requirements.alignment)) {
    fail('ALIGNMENT_MISMATCH', 'alignment', requirements.alignment);
  }
  for (const excluded of requirements.race_exclusions ?? []) {
    if (character.raceTags.includes(excluded)) fail('RACE_EXCLUDED', 'raceTags', excluded);
  }
  for (const required of requirements.race_tags_all ?? []) {
    if (!character.raceTags.includes(required)) fail('RACE_REQUIREMENT_MISSING', 'raceTags', required);
  }
  if (requirements.race_tags_any !== undefined
    && !requirements.race_tags_any.some(required => character.raceTags.includes(required))) {
    fail('RACE_REQUIREMENT_MISSING', 'raceTags', requirements.race_tags_any.join('|'));
  }
  if (requirements.bab_min !== undefined
    && (!Number.isSafeInteger(character.bab) || character.bab < requirements.bab_min)) {
    fail('BAB_TOO_LOW', 'bab', String(requirements.bab_min));
  }
  for (const [skill, minimum] of Object.entries(requirements.skills ?? {})) {
    const actual = character.skills[skill];
    if (!Number.isSafeInteger(actual) || (actual ?? -1) < minimum) {
      fail('SKILL_RANK_TOO_LOW', `skills.${skill}`, `${minimum}`);
    }
  }
  for (const pattern of requirements.skills_pattern ?? []) {
    if (!character.skillPatterns.includes(pattern)) fail('SKILL_PATTERN_MISSING', 'skillPatterns', pattern);
  }
  for (const feat of requirements.feats_all ?? []) {
    if (!character.feats.includes(feat)) fail('FEAT_MISSING', 'feats', feat);
  }
  for (const pattern of requirements.feats_pattern ?? []) {
    if (!character.featPatterns.includes(pattern)) fail('FEAT_PATTERN_MISSING', 'featPatterns', pattern);
  }
  for (const language of requirements.languages_all ?? []) {
    if (!character.languages.includes(language)) fail('LANGUAGE_MISSING', 'languages', language);
  }
  for (const proficiency of requirements.proficiencies ?? []) {
    if (!character.proficiencies.includes(proficiency)) fail('PROFICIENCY_MISSING', 'proficiencies', proficiency);
  }
  for (const predicate of requirements.spellcasting ?? []) {
    if (!character.spellcastingEvidence.includes(predicate)) {
      fail('SPELLCASTING_EVIDENCE_MISSING', 'spellcastingEvidence', predicate);
    }
  }
  for (const predicate of requirements.psionics ?? []) {
    if (!character.psionicsEvidence.includes(predicate)) {
      fail('PSIONICS_EVIDENCE_MISSING', 'psionicsEvidence', predicate);
    }
  }
  const evidenceIds: string[] = [];
  for (const predicate of requirements.special ?? []) {
    const evidence = validSpecialEvidence(predicate, character.specialEvidence);
    if (evidence === undefined) fail('SPECIAL_EVIDENCE_MISSING', 'specialEvidence', predicate);
    else evidenceIds.push(evidence.evidenceId);
  }

  return {
    prestigeId: prestige.id,
    nextLevel,
    eligible: failures.length === 0,
    failures,
    evidenceIds
  };
}
