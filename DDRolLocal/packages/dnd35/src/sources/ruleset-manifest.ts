import { err, ok, type Result } from '@nyx/domain';

export const DND35_RULESET_ID = 'dnd35_srd_ogc' as const;

export type Dnd35RulesetManifestV1 = {
  readonly ruleset_id: typeof DND35_RULESET_ID;
  readonly version: '1.0.0';
  readonly edition: '3.5';
  readonly system: 'd20';
  readonly source_policy: 'SRD_OGL_plus_registered_excerpts';
  readonly errata_precedence: true;
  readonly psionics_magic_transparency_default: true;
  readonly level_adjustment_buyoff_default: false;
  readonly fractional_bab_saves_default: false;
  readonly gestalt_default: false;
  readonly language: 'es';
  readonly machine_keys: 'en';
  readonly closed_source_memory_answers: false;
};

export type RulesetManifestError = {
  readonly code: 'MANIFEST_INVALID';
  readonly message: string;
};

const EXPECTED_MANIFEST: Dnd35RulesetManifestV1 = {
  ruleset_id: DND35_RULESET_ID,
  version: '1.0.0',
  edition: '3.5',
  system: 'd20',
  source_policy: 'SRD_OGL_plus_registered_excerpts',
  errata_precedence: true,
  psionics_magic_transparency_default: true,
  level_adjustment_buyoff_default: false,
  fractional_bab_saves_default: false,
  gestalt_default: false,
  language: 'es',
  machine_keys: 'en',
  closed_source_memory_answers: false
};

export function loadDnd35RulesetManifest(
  value: unknown
): Result<Dnd35RulesetManifestV1, RulesetManifestError> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return err({ code: 'MANIFEST_INVALID', message: 'El manifest debe ser un objeto.' });
  }

  const record = value as Record<string, unknown>;
  const expectedEntries = Object.entries(EXPECTED_MANIFEST);
  if (Object.keys(record).length !== expectedEntries.length) {
    return err({ code: 'MANIFEST_INVALID', message: 'El manifest contiene campos ausentes o no autorizados.' });
  }
  for (const [key, expected] of expectedEntries) {
    if (record[key] !== expected) {
      return err({ code: 'MANIFEST_INVALID', message: `El campo ${key} no coincide con el ruleset aprobado.` });
    }
  }

  return ok(structuredClone(EXPECTED_MANIFEST));
}
