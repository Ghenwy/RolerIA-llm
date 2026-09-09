import {
  validateRuntimeContract,
  type SotRuleQuery,
  type SotRuleResolution
} from '@nyx/contracts';
import { err, ok, type Result } from '@nyx/domain';

export type RuleQuery = SotRuleQuery.UrnNyxRpgDnd35RuleQuery10;
export type RuleResolution = SotRuleResolution.UrnNyxRpgDnd35RuleResolution10;

export type DndContractError = {
  readonly code:
    | 'CLOSED_SOURCE_UNREGISTERED'
    | 'INVALID_RULE_QUERY'
    | 'INVALID_RULE_RESOLUTION'
    | 'QUERY_ID_MISMATCH'
    | 'SOURCE_SCOPE_VIOLATION';
  readonly message: string;
};

function contractError(code: DndContractError['code'], message: string): Result<never, DndContractError> {
  return err({ code, message });
}

function uniqueNonEmpty(values: readonly string[]): boolean {
  return values.every(value => typeof value === 'string' && value.length > 0)
    && new Set(values).size === values.length;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index]);
}

export function validateRuleQuery(value: unknown): Result<RuleQuery, DndContractError> {
  const schema = validateRuntimeContract('RuleQuery', value);
  if (!schema.ok) return contractError('INVALID_RULE_QUERY', schema.errors.join(','));
  const query = value as RuleQuery;
  const scope = query.source_scope;
  if (query.query_id.length === 0
    || !uniqueNonEmpty(query.actors)
    || !uniqueNonEmpty(query.facts)
    || !uniqueNonEmpty(scope.allowed_source_ids)
    || !uniqueNonEmpty(scope.house_rule_ids)
    || !uniqueNonEmpty(scope.closed_source_excerpts)) {
    return contractError('INVALID_RULE_QUERY', 'IDs, actores, hechos y alcance deben ser únicos y no vacíos.');
  }
  const allScopeIds = [
    ...scope.allowed_source_ids,
    ...scope.house_rule_ids,
    ...scope.closed_source_excerpts
  ];
  if (new Set(allScopeIds).size !== allScopeIds.length) {
    return contractError('INVALID_RULE_QUERY', 'Una fuente no puede ocupar varias categorías de alcance.');
  }
  return ok(structuredClone(query));
}

function validRollProposal(value: unknown): boolean {
  return plainObject(value)
    && exactKeys(value, ['roll_id', 'roll_category', 'expression', 'reason'])
    && [value['roll_id'], value['expression'], value['reason']].every(item => typeof item === 'string' && item.length > 0)
    && typeof value['roll_category'] === 'string'
    && new Set(['ATTACK', 'SAVE', 'CHECK', 'MISS_CHANCE', 'DAMAGE', 'OTHER']).has(value['roll_category']);
}

function validModifier(value: unknown): boolean {
  return plainObject(value)
    && exactKeys(value, ['source', 'stacks', 'type', 'value'])
    && typeof value['value'] === 'number'
    && Number.isSafeInteger(value['value'])
    && typeof value['type'] === 'string'
    && value['type'].length > 0
    && typeof value['source'] === 'string'
    && value['source'].length > 0
    && typeof value['stacks'] === 'boolean';
}

function validResourceChange(value: unknown, selectedSources: ReadonlySet<string>): boolean {
  return plainObject(value)
    && exactKeys(value, ['delta', 'resource_id', 'source_ref'])
    && typeof value['resource_id'] === 'string'
    && value['resource_id'].length > 0
    && typeof value['delta'] === 'number'
    && Number.isSafeInteger(value['delta'])
    && typeof value['source_ref'] === 'string'
    && selectedSources.has(value['source_ref']);
}

function validStateEvent(value: unknown, selectedSources: ReadonlySet<string>): boolean {
  return plainObject(value)
    && exactKeys(value, ['event_type', 'payload', 'source_ref'])
    && typeof value['event_type'] === 'string'
    && value['event_type'].length > 0
    && plainObject(value['payload'])
    && typeof value['source_ref'] === 'string'
    && selectedSources.has(value['source_ref']);
}

export function validateRuleResolutionCandidate(
  rawQuery: unknown,
  value: unknown
): Result<{ readonly resolution: RuleResolution; readonly proposals_only: true }, DndContractError> {
  const queryResult = validateRuleQuery(rawQuery);
  if (!queryResult.ok) return queryResult;
  const schema = validateRuntimeContract('RuleResolution', value);
  if (!schema.ok) return contractError('INVALID_RULE_RESOLUTION', schema.errors.join(','));
  const resolution = value as RuleResolution;
  if (resolution.query_id !== queryResult.value.query_id) {
    return contractError('QUERY_ID_MISMATCH', 'RuleResolution no corresponde al RuleQuery.');
  }

  const scope = queryResult.value.source_scope;
  for (const source of resolution.sources) {
    if (source.authority === 'user_excerpt') {
      if (!scope.closed_source_excerpts.includes(source.source_id)) {
        return contractError('CLOSED_SOURCE_UNREGISTERED', 'El extracto cerrado no está registrado en el query.');
      }
    } else if (source.authority === 'house_rule') {
      if (!scope.house_rule_ids.includes(source.source_id)) {
        return contractError('SOURCE_SCOPE_VIOLATION', 'La house rule no está autorizada por el query.');
      }
    } else if (!scope.allowed_source_ids.includes(source.source_id)) {
      return contractError('SOURCE_SCOPE_VIOLATION', 'La fuente no está autorizada por el query.');
    }
  }

  const selectedSources = new Set(resolution.sources.map(source => source.source_id));
  const semanticShapeValid = resolution.query_id.length > 0
    && resolution.ruling.length > 0
    && resolution.ambiguities.every(item => item.length > 0)
    && resolution.sources.every(source => source.source_id.length > 0
      && source.section.length > 0
      && source.url.length > 0)
    && resolution.required_rolls.every(validRollProposal)
    && resolution.modifiers.every(validModifier)
    && resolution.resource_changes.every(change => validResourceChange(change, selectedSources))
    && resolution.state_events.every(event => validStateEvent(event, selectedSources));
  const statusValid = (resolution.status === 'resolved' || resolution.status === 'partial')
    ? resolution.sources.length > 0
    : resolution.status === 'conflict'
      ? new Set(resolution.sources.map(source => source.source_id)).size >= 2 && resolution.ambiguities.length > 0
      : resolution.status === 'blocked' && resolution.ambiguities.length > 0;
  if (!semanticShapeValid || !statusValid) {
    return contractError('INVALID_RULE_RESOLUTION', 'La resolución no satisface las invariantes semánticas del Rules Arbiter.');
  }
  return ok({ resolution: structuredClone(resolution), proposals_only: true });
}
