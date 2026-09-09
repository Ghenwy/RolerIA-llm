import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { ApplicationPortResult, CampaignRulesPort, RulesAdapter } from '@nyx/application';
import { validateJsonSchema, validateRuntimeContract, type CampaignManifest, type DesignGuidedTurnIntentV1, type InternalRuleSourceRecord, type SotRuleQuery, type SotRuleResolution } from '@nyx/contracts';
import { DND35_RULESET_ID, Dnd35RulesAdapter, JsonDnd35AdapterEventStore, loadDnd35RulesetManifest, loadProtectedDnd35Catalog,
  type Dnd35AdapterState, type LoadedRuleSource, type PersistedRuling } from '@nyx/dnd35';
import { captureDnd35Boundary, Dnd35BoundaryError } from '@nyx/persistence-json';
import stateSchema from '../packages/contracts/schemas/internal/campaign-state.schema.json' with { type: 'json' };
import { canonicalJson, type AtomicEvent, type CampaignState } from '@nyx/domain';

type RuleScope = SotRuleQuery.UrnNyxRpgDnd35RuleQuery10['source_scope'];
type RuleResolution = SotRuleResolution.UrnNyxRpgDnd35RuleResolution10;
type RulesBinding = {
  manifest: CampaignManifest;
  adapter: RulesAdapter;
  scopes: string[];
  sourceScope: (ruleId: string) => RuleScope;
};
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function sameRefs(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && new Set(left).size === left.length && left.every(ref => right.includes(ref));
}
function validatedRuling(value: unknown, campaignId: string): value is PersistedRuling {
  if (!record(value)) return false;
  const keys = ['ruling_id', 'question', 'answer', 'source_refs', 'errata_status', 'scope', 'campaign_id', 'created_at', 'supersedes'];
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
    && ['ruling_id', 'question', 'answer', 'scope', 'created_at'].every(key => typeof value[key] === 'string' && value[key].length > 0)
    && value['campaign_id'] === campaignId && value['errata_status'] === 'checked_compatible'
    && !Number.isNaN(Date.parse(String(value['created_at'])))
    && Array.isArray(value['source_refs']) && value['source_refs'].length > 0
    && value['source_refs'].every(ref => typeof ref === 'string' && ref.length > 0)
    && new Set(value['source_refs']).size === value['source_refs'].length
    && (value['supersedes'] === null || (typeof value['supersedes'] === 'string' && value['supersedes'].length > 0));
}
function resolveLiteral(binding: RulesBinding, ruleId: string, question: string, queryId: string): ApplicationPortResult<RuleResolution> {
  const resolved = binding.adapter.resolveRule({ query: {
    query_id: queryId, ruleset_id: binding.manifest.ruleset_id, state_version: binding.manifest.state_version,
    question, actors: [], facts: [], source_scope: binding.sourceScope(ruleId), requested_resolution: 'interaction'
  }, ruleId, material: 'OPEN' });
  if (!resolved.ok) return resolved;
  if (!record(resolved.value) || resolved.value['metadata_only'] === true
    || !validateRuntimeContract('RuleResolution', resolved.value['resolution']).ok) return failure('SOURCE_BLOCKED');
  const resolution = resolved.value['resolution'] as RuleResolution;
  return resolution.status === 'resolved' && resolution.sources.length > 0
    ? { ok: true, value: resolution } : failure('SOURCE_BLOCKED');
}

const failure = (code: string): ApplicationPortResult<never> => ({ ok: false, error: { code, message: 'Consulta de reglas bloqueada; no se ha modificado la campaña.' } });
async function optionalText(file: string): Promise<string> {
  try { return await fs.readFile(file, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error; }
}
async function absent(file: string): Promise<boolean> {
  try { await fs.lstat(file); return false; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; throw error; }
}

/** Composition only: strict reads must never invoke open()/tail() recovery as a side effect. */
export class LocalCampaignRules implements CampaignRulesPort {
  readonly #productRoot: string;
  readonly #campaignsRoot: string;

  constructor(productRoot: string, campaignsRoot: string) {
    this.#productRoot = path.resolve(productRoot);
    this.#campaignsRoot = path.resolve(campaignsRoot);
  }

  async open(campaignId: string): Promise<ApplicationPortResult<{ manifest: unknown; adapter: RulesAdapter }>> {
    const binding = await this.#openBinding(campaignId);
    return binding.ok ? { ok: true, value: { manifest: binding.value.manifest, adapter: binding.value.adapter } } : binding;
  }

  /** DEC-081: the caller supplies a scope, not source permissions, a ruleset or a proposed answer. */
  async resolveRegistered(campaignId: string, intent: unknown, expectedStateVersion: number) {
    if (!validateRuntimeContract('GuidedTurnIntent', intent).ok
      || !Number.isSafeInteger(expectedStateVersion) || expectedStateVersion < 0) return failure('SCHEMA_INVALID');
    const query = intent as DesignGuidedTurnIntentV1.GuidedTurnIntentV1;
    if (query.kind !== 'rule') return failure('SCHEMA_INVALID');
    const opened = await this.#openBinding(campaignId);
    if (!opened.ok) return opened;
    if (opened.value.manifest.state_version !== expectedStateVersion) return failure('STALE_STATE');
    if (!opened.value.scopes.includes(query.scope)) return { ok: false as const, error: {
      code: 'SOURCE_BLOCKED', message: `Ámbito no registrado. Usa /rule <scope> <pregunta>. Ámbitos registrados: ${opened.value.scopes.join(', ') || 'ninguno'}.`
    } };
    const resolved = resolveLiteral(opened.value, query.scope, query.question, 'QUERY-guided-read');
    return resolved.ok ? { ok: true as const, value: {
      rulesetId: opened.value.manifest.ruleset_id, stateVersion: opened.value.manifest.state_version,
      ruling: resolved.value.ruling, sourceRefs: resolved.value.sources.map(source => source.source_id)
    } } : resolved;
  }

  /** New admissions only: source metadata and model paraphrases are never rule authority. */
  async validateProposedRulings(campaignId: string, events: readonly unknown[]): Promise<ApplicationPortResult<void>> {
    if (!events.some(event => record(event) && event['event_type'] === 'RULE_RULING_RECORDED')) return { ok: true, value: undefined };
    const opened = await this.#openBinding(campaignId);
    if (!opened.ok) return opened;
    const binding = opened.value;
    const scopes = new Set<string>();
    for (const [index, candidate] of events.entries()) {
      if (!record(candidate) || candidate['event_type'] !== 'RULE_RULING_RECORDED') continue;
      if (!validateRuntimeContract('DomainEvent', candidate).ok) return failure('SCHEMA_INVALID');
      const event = candidate as unknown as AtomicEvent;
      const payload = event.payload;
      if (!validatedRuling(payload, campaignId) || !sameRefs(payload.source_refs, event.source_refs)) return failure('SCHEMA_INVALID');
      if (scopes.has(payload.scope)) return failure('RULE_ALREADY_RESOLVED');
      scopes.add(payload.scope);
      if (event.campaign_id !== campaignId || payload['campaign_id'] !== campaignId || event.branch_id !== binding.manifest.active_branch_id
        || event.base_state_version !== binding.manifest.state_version + index
        || event.committed_state_version !== event.base_state_version + 1) return failure('STALE_STATE');
      const resolved = resolveLiteral(binding, String(payload['scope']), String(payload['question']), `QUERY-${event.event_id}`);
      if (!resolved.ok) return resolved;
      // Reuse the existing ruling rather than creating a redundant ruling-on-ruling lineage.
      if (resolved.value.sources.some(source => source.authority === 'campaign_ruling')) return failure('RULE_ALREADY_RESOLVED');
      if (payload['answer'] !== resolved.value.ruling || !sameRefs(event.source_refs, resolved.value.sources.map(source => source.source_id))) {
        return failure('RULE_PROVENANCE_MISMATCH');
      }
    }
    return { ok: true, value: undefined };
  }

  async availableRuleScopes(campaignId: string): Promise<ApplicationPortResult<{ ruleset_id: string; state_version: number; rule_refs: string[] }>> {
    const opened = await this.#openBinding(campaignId);
    return opened.ok ? { ok: true, value: { ruleset_id: opened.value.manifest.ruleset_id, state_version: opened.value.manifest.state_version,
      rule_refs: opened.value.scopes.map(scope => `rule:${scope}`) } } : opened;
  }

  /** [DESIGN] Explicit rule:<scope> refs only; never infer authority from a Job Card objective/facts. */
  async workerRuleContext(campaignId: string, requestedRefs: readonly string[]): Promise<ApplicationPortResult<{
    ruleset_id: string; state_version: number; rules: { rule_ref: string; resolution: RuleResolution }[];
  }>> {
    if (requestedRefs.length === 0 || new Set(requestedRefs).size !== requestedRefs.length
      || requestedRefs.some(ref => !ref.startsWith('rule:') || ref.slice(5).trim().length === 0)) return failure('SOURCE_BLOCKED');
    const opened = await this.#openBinding(campaignId);
    if (!opened.ok) return opened;
    const rules: { rule_ref: string; resolution: RuleResolution }[] = [];
    for (const ruleRef of requestedRefs) {
      const resolved = resolveLiteral(opened.value, ruleRef.slice(5), `Resolver literalmente la regla registrada ${ruleRef}.`, `QUERY-${rules.length}`);
      if (!resolved.ok) return resolved;
      rules.push({ rule_ref: ruleRef, resolution: resolved.value });
    }
    return { ok: true, value: { ruleset_id: opened.value.manifest.ruleset_id, state_version: opened.value.manifest.state_version, rules } };
  }

  async #openBinding(campaignId: string): Promise<ApplicationPortResult<RulesBinding>> {
    if (!/^CAMPAIGN-[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(campaignId)) return failure('SCHEMA_INVALID');
    const root = path.join(this.#campaignsRoot, campaignId);
    try {
      const manifestText = await fs.readFile(path.join(root, 'campaign.json'), 'utf8');
      const raw: unknown = JSON.parse(manifestText);
      if (!validateRuntimeContract('CampaignManifest', raw).ok) return failure('SCHEMA_INVALID');
      const manifest = raw as CampaignManifest;
      if (manifest.campaign_id !== campaignId) return failure('RULESET_MISMATCH');
      if (manifest.ruleset_id !== DND35_RULESET_ID) return failure('RULES_ADAPTER_UNAVAILABLE');
      const ruleset = loadDnd35RulesetManifest(JSON.parse(await fs.readFile(
        path.join(this.#productRoot, 'rulesets', DND35_RULESET_ID, 'manifest.json'), 'utf8')));
      if (!ruleset.ok) return failure('SCHEMA_INVALID');
      const catalog = await loadProtectedDnd35Catalog({ productRoot: this.#productRoot });
      if (!catalog.ok) return failure(catalog.error.code);

      const boundaryClear = async () => (await fs.readdir(path.join(root, 'transactions'))).length === 0
        && await absent(path.join(root, 'locks', 'writer.lock.json'));
      if (!await boundaryClear()) return failure('CAMPAIGN_BUSY');
      const snapshotName = `${manifest.active_branch_id}.${String(manifest.state_version).padStart(12, '0')}.json`;
      const states = (await fs.readdir(path.join(root, 'state')))
        .filter(file => file.startsWith(`${manifest.active_branch_id}.`) && file.endsWith('.json')).sort();
      if (states.at(-1) !== snapshotName) return failure('STALE_STATE');
      const snapshot: unknown = JSON.parse(await fs.readFile(path.join(root, 'state', snapshotName), 'utf8'));
      if (!validateJsonSchema(stateSchema, snapshot).ok) return failure('CORRUPT_DATA');
      const state = snapshot as CampaignState;
      if (state.campaign_id !== campaignId || state.branch_id !== manifest.active_branch_id || state.state_version !== manifest.state_version) {
        return failure('RULESET_MISMATCH');
      }
      const eventFile = path.join(root, 'dnd35-events', `${manifest.active_branch_id}.jsonl`);
      const eventText = await optionalText(eventFile);
      if (eventText !== '' && !eventText.endsWith('\n')) return failure('CORRUPT_DATA');
      const boundary = await captureDnd35Boundary(root, campaignId, manifest.active_branch_id);
      const loadedEvents = await new JsonDnd35AdapterEventStore(root).tail(manifest.active_branch_id);
      if (!loadedEvents.ok) return failure(loadedEvents.error.code);
      const events = loadedEvents.value;
      const replay = await new JsonDnd35AdapterEventStore(root).replay(manifest.active_branch_id);
      if (!replay.ok) return failure(replay.error.code);
      if ((replay.value.campaign_id !== undefined && replay.value.campaign_id !== campaignId)
        ) return failure('RULESET_MISMATCH');
      const sources: LoadedRuleSource[] = [];
      for (const event of events.filter(event => event.event_type === 'RULE_SOURCE_REGISTERED')) {
        const payload = event.payload as Record<string, unknown>;
        if (!validateRuntimeContract('RuleSourceRecord', payload['source_record']).ok) return failure('SOURCE_BLOCKED');
        const record = payload['source_record'] as InternalRuleSourceRecord.RuleSourceRecordV1;
        if (record.source_id === 'SOURCE-SRD-CORE' || sources.some(source => source.record.source_id === record.source_id)
          || payload['record_id'] !== record.source_id || !event.source_refs.includes(record.source_id)
          || record.local_excerpt_ref === null || record.content_sha256 === null
          || !['SRD_OGC', 'OFFICIAL_ERRATA', 'USER_OWNED_EXCERPT'].includes(record.source_kind)
          || record.edition !== '3.5' || typeof payload['source_url'] !== 'string') return failure('SOURCE_BLOCKED');
        const bytes = boundary.artifacts.find(item => item.entry.kind === 'rule_source' && item.entry.relative_path === record.local_excerpt_ref)?.bytes;
        if (!bytes) return failure('SOURCE_BLOCKED');
        if (crypto.createHash('sha256').update(bytes).digest('hex') !== record.content_sha256) return failure('SOURCE_HASH_MISMATCH');
        const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        if (!content.trim()) return failure('SOURCE_BLOCKED');
        sources.push({ record, content, url: payload['source_url'] });
      }
      if (!await boundaryClear() || manifestText !== await fs.readFile(path.join(root, 'campaign.json'), 'utf8')
        || eventText !== await optionalText(eventFile)
        || canonicalJson(boundary.artifacts.map(item => item.entry)) !== canonicalJson((await captureDnd35Boundary(root, campaignId, manifest.active_branch_id)).artifacts.map(item => item.entry))) return failure('STALE_STATE');
      const enabledSources = sources.filter(source => source.record.enabled);
      const bindingFor = (adapterState: Dnd35AdapterState): RulesBinding => {
        const superseded = new Set(Object.values(adapterState.rulings).map(ruling => ruling.supersedes));
        const rulings = Object.values(adapterState.rulings).filter(ruling => !superseded.has(ruling.ruling_id));
        const houseRules = Object.values(adapterState.house_rules).filter(rule => rule.enabled);
        const sourceScope = (ruleId: string): RuleScope => ({
          allowed_source_ids: [
            ...enabledSources.filter(source => source.record.source_kind !== 'USER_OWNED_EXCERPT' && source.record.allowed_scope.includes(ruleId))
              .map(source => source.record.source_id),
            ...rulings.filter(rule => rule.scope === ruleId || rule.scope === 'campaign').map(rule => rule.ruling_id)
          ],
          house_rule_ids: houseRules.filter(rule => rule.scope === ruleId || rule.scope === 'campaign').map(rule => rule.house_rule_id),
          closed_source_excerpts: enabledSources.filter(source => source.record.source_kind === 'USER_OWNED_EXCERPT' && source.record.allowed_scope.includes(ruleId))
            .map(source => source.record.source_id)
        });
        const scopes = [...new Set([
          ...enabledSources.flatMap(source => source.record.allowed_scope), ...rulings.map(rule => rule.scope), ...houseRules.map(rule => rule.scope)
        ])].sort();
        return { manifest, scopes, sourceScope, adapter: new Dnd35RulesAdapter(catalog.value, adapterState, manifest.state_version, sources, state.rng,
          { campaignId, branchId: manifest.active_branch_id }) };
      };
      // Read-only reconciliation: a core snapshot's presence is not evidence that its ruling is true.
      const combined = { ...replay.value.rulings };
      const pending = new Map<string, PersistedRuling>();
      for (const [id, ruling] of Object.entries(state.canon.rulings)) {
        if (!validatedRuling(ruling, campaignId) || ruling.ruling_id !== id
          || (combined[id] !== undefined && canonicalJson(combined[id]) !== canonicalJson(ruling))) return failure('SOURCE_BLOCKED');
        pending.set(id, ruling);
        delete combined[id]; // Never use the candidate itself as its source, even if copied to both logs.
      }
      while (pending.size > 0) {
        let progressed = false;
        for (const [id, ruling] of pending) {
          if (ruling.source_refs.some(ref => pending.has(ref)) || (ruling.supersedes !== null && pending.has(ruling.supersedes))) continue;
          if (ruling.supersedes !== null && (combined[ruling.supersedes] === undefined
            || combined[ruling.supersedes]?.scope !== ruling.scope)) return failure('SOURCE_BLOCKED');
          const resolved = resolveLiteral(bindingFor({ ...replay.value, rulings: combined }), ruling.scope, ruling.question, `QUERY-${id}`);
          if (!resolved.ok || ruling.answer !== resolved.value.ruling
            || !sameRefs(ruling.source_refs, resolved.value.sources.map(source => source.source_id))) return failure('SOURCE_BLOCKED');
          combined[id] = structuredClone(ruling);
          pending.delete(id);
          progressed = true;
        }
        if (!progressed) return failure('SOURCE_BLOCKED');
      }
      return { ok: true, value: bindingFor({ ...replay.value, rulings: combined }) };
    } catch (error) {
      if (error instanceof Dnd35BoundaryError) {
        return failure(error.code === 'CAMPAIGN_MISMATCH' ? 'RULESET_MISMATCH'
          : error.code === 'UNSAFE_PATH' ? 'SOURCE_BLOCKED' : error.code);
      }
      return failure(error instanceof SyntaxError ? 'SCHEMA_INVALID' : 'RULES_CONTEXT_UNAVAILABLE');
    }
  }
}
