import crypto from 'node:crypto';
import { err, ok, type Result } from '@nyx/domain';
import type { InternalRuleSourceRecord } from '@nyx/contracts';
import { SourceRegistry } from './source-registry.js';
import type { Dnd35AdapterState } from '../events/adapter-events.js';
import { validateRuleResolutionCandidate, type RuleQuery, type RuleResolution } from '../contracts/rule-contracts.js';

export type LoadedRuleSource = {
  readonly record: InternalRuleSourceRecord.RuleSourceRecordV1;
  readonly url: string;
  readonly content: string;
};
const hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const blocked = (code = 'SOURCE_BLOCKED') => err({ code, message: 'Fuentes ausentes, incompatibles o fuera del alcance registrado.' });
const authorities = { HOUSE_RULE: 'house_rule', OFFICIAL_ERRATA: 'official_errata', SRD_OGC: 'srd_ogc',
  PERSISTED_RULING: 'campaign_ruling', USER_OWNED_EXCERPT: 'user_excerpt' } as const;
export function resolveApplicationSources(query: RuleQuery, ruleId: string, material: 'OPEN' | 'CLOSED',
  sources: readonly LoadedRuleSource[], state: Dnd35AdapterState, compiled?: string
): Result<{ resolution: RuleResolution; proposals_only: true; compiled_selected: boolean }, { code: string; message: string }> {
  const candidates = sources.filter(source => source.record.enabled && source.record.allowed_scope.includes(ruleId))
    .map(source => ({ ...source, publicId: source.record.source_id, compatible: true, compiled: false }));
  const local = (publicId: string, kind: 'HOUSE_RULE' | 'PERSISTED_RULING' | 'SRD_OGC', content: string, compatible: boolean, compiledValue = false) => ({
    publicId, url: kind === 'SRD_OGC' ? 'https://www.d20srd.org/' : `urn:nyx:campaign-rule:${encodeURIComponent(publicId)}`,
    content, compatible, compiled: compiledValue,
    record: { schema_version: '1.0' as const, source_id: kind === 'SRD_OGC' ? publicId : `SOURCE-${hash(publicId)}`, source_kind: kind,
      title: publicId, edition: '3.5', version_or_date: null, ownership_assertion: null, local_excerpt_ref: null,
      allowed_scope: [ruleId], content_sha256: hash(content), public_distribution_allowed: false, enabled: true }
  });
  if (compiled !== undefined) candidates.push(local('SOURCE-SRD-CORE', 'SRD_OGC', compiled, true, true));
  for (const rule of Object.values(state.house_rules)) {
    if (rule.enabled && (rule.scope === ruleId || rule.scope === 'campaign')) candidates.push(local(rule.house_rule_id, 'HOUSE_RULE', rule.rule, true));
  }
  const superseded = new Set(Object.values(state.rulings).map(ruling => ruling.supersedes));
  for (const ruling of Object.values(state.rulings)) {
    if (!superseded.has(ruling.ruling_id) && (ruling.scope === ruleId || ruling.scope === 'campaign')) {
      const refsExist = ruling.source_refs.every(ref => sources.some(source => source.record.source_id === ref && source.record.enabled));
      candidates.push(local(ruling.ruling_id, 'PERSISTED_RULING', ruling.answer, ruling.errata_status === 'checked_compatible' && refsExist));
    }
  }
  const scope = query.source_scope;
  const requested = [...scope.allowed_source_ids, ...scope.house_rule_ids, ...scope.closed_source_excerpts];
  // Omission cannot be used to bypass a registered higher-precedence source.
  if (candidates.length === 0 || requested.some(id => !candidates.some(c => c.publicId === id))
    || candidates.some(c => !requested.includes(c.publicId)
      || !(c.record.source_kind === 'HOUSE_RULE' ? scope.house_rule_ids
        : c.record.source_kind === 'USER_OWNED_EXCERPT' ? scope.closed_source_excerpts : scope.allowed_source_ids).includes(c.publicId))) return blocked();
  const registry = SourceRegistry.create(candidates.map(candidate => candidate.record));
  if (!registry.ok) return blocked();
  const result = registry.value.resolve({ ruleId, material, candidates: candidates.map(candidate => ({ sourceId: candidate.record.source_id,
    value: candidate.content, claimFingerprint: hash(candidate.content), compatibleWithHigherPrecedence: candidate.compatible })) });
  if (result.status !== 'RESOLVED') return blocked(result.status === 'CONFLICT' ? 'SOURCE_CONFLICT' : 'SOURCE_BLOCKED');
  const selected = candidates.filter(candidate => result.sourceRefs.includes(candidate.record.source_id));
  const validation = validateRuleResolutionCandidate(query, {
    query_id: query.query_id, status: 'resolved', ruling: result.value,
    sources: selected.map(candidate => ({ source_id: candidate.publicId, section: ruleId, url: candidate.url, authority: authorities[candidate.record.source_kind] })),
    required_rolls: [], modifiers: [], resource_changes: [], state_events: [], ambiguities: [], confidence: 1
  });
  return validation.ok ? ok({ ...validation.value, compiled_selected: selected.every(candidate => candidate.compiled) }) : validation;
}
