import fs from 'node:fs/promises';
import path from 'node:path';
import { validateRuntimeContract, type InternalCheckpointManifestV12, type InternalDnd35AdapterEvent, type InternalRuleSourceRecord, type InternalTimelineEntry } from '@nyx/contracts';
import { validateCampaignInvariants, type AtomicEvent, type CampaignState } from '@nyx/domain';
import { canonicalJson, sha256 } from './canonical-json.js';
import { validateCheckpointSchema, validateEventSchema, validateStateSchema, validateTimelineSchema } from './validators.js';

type Event = InternalDnd35AdapterEvent.Dnd35AdapterEventV1;
type Artifact = InternalCheckpointManifestV12.CheckpointManifestV12['artifacts'][number];
export type CheckpointArtifactBytes = { entry: Artifact; bytes: Buffer };
export type Dnd35Boundary = { artifacts: CheckpointArtifactBytes[]; events: Event[] };
export class Dnd35BoundaryError extends Error {
  constructor(readonly code: 'UNSAFE_PATH' | 'SOURCE_BLOCKED' | 'SOURCE_HASH_MISMATCH' | 'CAMPAIGN_MISMATCH', message: string) {
    super(message);
    this.name = 'Dnd35BoundaryError';
  }
}

/** Only canonical relative paths; reject symlinks even when they happen to point inside the root. */
export async function readBoundFile(root: string, relative: string): Promise<Buffer> {
  if (!relative || relative.includes('\\') || relative.includes(':') || path.posix.isAbsolute(relative)
    || relative.split('/').some(part => !part || part === '.' || part === '..')) throw new Dnd35BoundaryError('UNSAFE_PATH', 'Unsafe artifact path');
  let cursor = path.resolve(root);
  if ((await fs.lstat(cursor)).isSymbolicLink()) throw new Dnd35BoundaryError('UNSAFE_PATH', 'Symlink root');
  for (const part of relative.split('/')) {
    cursor = path.join(cursor, part);
    if ((await fs.lstat(cursor)).isSymbolicLink()) throw new Dnd35BoundaryError('UNSAFE_PATH', 'Symlink artifact');
  }
  if (!(await fs.stat(cursor)).isFile()) throw new Error('Artifact is not a file');
  return fs.readFile(cursor);
}

function parseLines(bytes: Buffer): unknown[] {
  if (bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) throw new Error('JSONL requires UTF-8 without BOM');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (text.includes('\r')) throw new Error('JSONL requires LF');
  if (text !== '' && !text.endsWith('\n')) throw new Error('Partial JSONL tail');
  return text === '' ? [] : text.slice(0, -1).split('\n').map(line => JSON.parse(line) as unknown);
}

async function optional(root: string, relative: string): Promise<Buffer> {
  try { return await readBoundFile(root, relative); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Buffer.alloc(0); throw error; }
}

async function origin(root: string, campaign: string, branch: string) {
  const entries = parseLines(await optional(root, 'timeline/entries.jsonl')) as InternalTimelineEntry.TimelineEntryV1[];
  const ids = new Set<string>();
  for (const entry of entries) {
    if (validateTimelineSchema(entry).length || entry.campaign_id !== campaign || ids.has(entry.timeline_event_id)) throw new Error('Invalid timeline');
    ids.add(entry.timeline_event_id);
  }
  const origins = entries.filter(entry => entry.type === 'BRANCH_CREATED' && entry.branch_id === branch);
  if (origins.length > 1) throw new Error('Ambiguous branch ancestry');
  return origins[0];
}

function artifact(kind: Artifact['kind'], relative_path: string, bytes: Buffer): CheckpointArtifactBytes {
  return { entry: { kind, relative_path, byte_length: bytes.length, sha256: sha256(bytes) }, bytes };
}

/** Structural validation here; semantic D&D reducers remain in their owning package. */
function validateBoundary(artifacts: CheckpointArtifactBytes[], campaign: string): Event[] {
  const paths = new Set<string>();
  const ids = new Set<string>();
  const sourceIds = new Set<string>();
  const needed = new Map<string, string>();
  const events: Event[] = [];
  let version = 0;
  let sourcesStarted = false;
  for (const { entry, bytes } of artifacts) {
    if (paths.has(entry.relative_path.toLowerCase()) || sha256(bytes) !== entry.sha256 || bytes.length !== entry.byte_length) throw new Error('Artifact mismatch');
    paths.add(entry.relative_path.toLowerCase());
    if (entry.kind === 'rule_source') {
      sourcesStarted = true;
      if (!entry.relative_path.startsWith('rules/')) throw new Error('Invalid rule source path');
      continue;
    }
    if (sourcesStarted) throw new Error('Event segments must precede sources');
    const branch = /^dnd35-events\/(BRANCH-[A-Za-z0-9][A-Za-z0-9._-]*)\.jsonl$/.exec(entry.relative_path)?.[1];
    if (!branch) throw new Error('Invalid event segment path');
    for (const raw of parseLines(bytes)) {
      if (!validateRuntimeContract('Dnd35AdapterEvent', raw).ok) throw new Error('Invalid adapter schema');
      const event = raw as Event;
      if (event.campaign_id !== campaign) throw new Dnd35BoundaryError('CAMPAIGN_MISMATCH', 'Foreign adapter campaign');
      if (event.branch_id !== branch || ids.has(event.event_id)
        || event.base_adapter_version !== version || event.committed_adapter_version !== version + 1) throw new Error('Invalid adapter sequence');
      ids.add(event.event_id);
      version++;
      events.push(event);
      if (event.event_type === 'RULE_SOURCE_REGISTERED') {
        const payload = event.payload as Record<string, unknown>;
        if (!validateRuntimeContract('RuleSourceRecord', payload['source_record']).ok) throw new Error('Invalid source schema');
        const source = payload['source_record'] as InternalRuleSourceRecord.RuleSourceRecordV1;
        if (sourceIds.has(source.source_id) || payload['record_id'] !== source.source_id || !event.source_refs.includes(source.source_id)) throw new Error('Invalid source identity');
        sourceIds.add(source.source_id);
        if (source.local_excerpt_ref !== null || source.content_sha256 !== null) {
          if (source.local_excerpt_ref === null || source.content_sha256 === null || !source.local_excerpt_ref.startsWith('rules/')) throw new Error('Invalid source binding');
          const previous = needed.get(source.local_excerpt_ref);
          if (previous !== undefined && previous !== source.content_sha256) throw new Error('Conflicting source bytes');
          needed.set(source.local_excerpt_ref, source.content_sha256);
        }
      }
    }
  }
  const sources = artifacts.filter(item => item.entry.kind === 'rule_source');
  if (sources.some((item, index) => index > 0 && sources[index - 1]!.entry.relative_path >= item.entry.relative_path)) throw new Error('Unsorted source inventory');
  if (sources.length !== needed.size || sources.some(item => needed.get(item.entry.relative_path) !== item.entry.sha256)) throw new Error('Source coverage mismatch');
  return events;
}

async function inherited(root: string, campaign: string, branch: string, seen: Set<string>): Promise<Dnd35Boundary> {
  if (seen.has(branch)) throw new Error('Cyclic branch ancestry');
  seen.add(branch);
  const parent = await origin(root, campaign, branch);
  if (!parent) return { artifacts: [], events: [] };
  if (!parent.parent_branch_id || !parent.parent_checkpoint_id || parent.parent_branch_id === branch) throw new Error('Invalid parent lineage');
  const boundary = await readSnapshot(root, parent.parent_checkpoint_id, campaign, seen);
  if (boundary.branch !== parent.parent_branch_id) throw new Error('Foreign parent branch');
  return boundary;
}

async function readSnapshot(root: string, id: string, campaign: string | undefined, seen: Set<string>): Promise<Dnd35Boundary & { branch: string }> {
  if (!/^CHECKPOINT-[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) throw new Error('Unsafe checkpoint id');
  const directory = path.join(root, 'checkpoints', id);
  const raw = JSON.parse((await readBoundFile(root, `checkpoints/${id}/manifest.json`)).toString('utf8')) as InternalCheckpointManifestV12.CheckpointManifestV12;
  if (validateCheckpointSchema(raw).length || raw.checkpoint_id !== id || (campaign !== undefined && raw.campaign_id !== campaign)) throw new Error('Invalid checkpoint manifest');
  const stateBytes = await readBoundFile(directory, raw.state_file);
  const eventBytes = await readBoundFile(directory, raw.event_file);
  if (sha256(stateBytes) !== raw.state_sha256 || sha256(eventBytes) !== raw.event_tail_hash) throw new Error('Invalid checkpoint core hashes');
  const state = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(stateBytes)) as CampaignState;
  const coreEvents = parseLines(eventBytes) as AtomicEvent[];
  if (validateStateSchema(state).length || validateCampaignInvariants(state).length || coreEvents.some(event => validateEventSchema(event).length)
    || state.campaign_id !== raw.campaign_id || state.branch_id !== raw.branch_id || state.state_version !== raw.state_version
    || sha256(canonicalJson(state.rng)) !== raw.rng_hash || coreEvents.length !== raw.event_count
    || (coreEvents.at(-1)?.event_id ?? null) !== raw.event_tail_event_id) throw new Error('Invalid checkpoint core contents');
  if (raw.schema_version !== '1.2') {
    if ((await optional(root, `dnd35-events/${raw.branch_id}.jsonl`)).length > 0) throw new Error('Legacy checkpoint lacks D&D authority');
    const base = await inherited(root, raw.campaign_id, raw.branch_id, seen);
    if (base.artifacts.length > 0) throw new Error('Legacy checkpoint lacks inherited D&D authority');
    return { artifacts: [], events: [], branch: raw.branch_id };
  }
  const base = await inherited(root, raw.campaign_id, raw.branch_id, seen);
  const artifacts: CheckpointArtifactBytes[] = [];
  for (const entry of raw.artifacts) artifacts.push({ entry, bytes: await readBoundFile(directory, entry.relative_path) });
  const files: string[] = [];
  const visit = async (relative: string): Promise<void> => {
    const target = path.join(directory, relative);
    let stat;
    try { stat = await fs.lstat(target); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    if (stat.isSymbolicLink()) throw new Error('Symlink checkpoint artifact');
    if (stat.isDirectory()) for (const child of await fs.readdir(target)) await visit(`${relative}/${child}`);
    else if (stat.isFile()) files.push(relative);
    else throw new Error('Unsupported checkpoint artifact');
  };
  await visit('rules'); await visit('dnd35-events');
  if (files.length !== artifacts.length || files.some(file => !artifacts.some(item => item.entry.relative_path === file))) throw new Error('Unlisted checkpoint artifact');
  const eventArtifacts = artifacts.filter(item => item.entry.kind === 'dnd35_events');
  const parentEvents = base.artifacts.filter(item => item.entry.kind === 'dnd35_events');
  if (eventArtifacts.length < parentEvents.length || eventArtifacts.length > parentEvents.length + 1) throw new Error('Invalid ancestry segment count');
  for (const [index, item] of parentEvents.entries()) {
    const current = eventArtifacts[index]?.entry;
    if (current?.relative_path !== item.entry.relative_path || current.sha256 !== item.entry.sha256 || current.byte_length !== item.entry.byte_length) throw new Error('Ancestor segment changed');
  }
  if (eventArtifacts.length > parentEvents.length && eventArtifacts.at(-1)?.entry.relative_path !== `dnd35-events/${raw.branch_id}.jsonl`) throw new Error('Foreign branch segment');
  for (const item of base.artifacts.filter(item => item.entry.kind === 'rule_source')) {
    if (artifacts.find(candidate => candidate.entry.relative_path === item.entry.relative_path)?.entry.sha256 !== item.entry.sha256) throw new Error('Inherited source changed');
  }
  return { artifacts, events: validateBoundary(artifacts, raw.campaign_id), branch: raw.branch_id };
}

export async function readCheckpointArtifacts(root: string, checkpointId: string, campaignId?: string): Promise<Dnd35Boundary> {
  return readSnapshot(root, checkpointId, campaignId, new Set());
}

export async function captureDnd35Boundary(root: string, campaignId: string, branchId: string): Promise<Dnd35Boundary> {
  if (!/^BRANCH-[A-Za-z0-9][A-Za-z0-9._-]*$/.test(branchId)) throw new Error('Unsafe branch');
  const base = await inherited(root, campaignId, branchId, new Set());
  const segments = base.artifacts.filter(item => item.entry.kind === 'dnd35_events');
  const own = await optional(root, `dnd35-events/${branchId}.jsonl`);
  if (own.length > 0) segments.push(artifact('dnd35_events', `dnd35-events/${branchId}.jsonl`, own));
  const needed = new Map<string, string>();
  for (const segment of segments) for (const raw of parseLines(segment.bytes)) {
    if (!validateRuntimeContract('Dnd35AdapterEvent', raw).ok) throw new Error('Invalid adapter schema');
    const event = raw as Event;
    if (event.event_type !== 'RULE_SOURCE_REGISTERED') continue;
    const source = (event.payload as Record<string, unknown>)['source_record'] as InternalRuleSourceRecord.RuleSourceRecordV1;
    if (!validateRuntimeContract('RuleSourceRecord', source).ok) throw new Dnd35BoundaryError('SOURCE_BLOCKED', 'Invalid source schema');
    if (source.local_excerpt_ref !== null) needed.set(source.local_excerpt_ref, source.content_sha256 ?? '');
  }
  const sources: CheckpointArtifactBytes[] = [];
  for (const [relative, hash] of [...needed.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    const frozen = base.artifacts.find(item => item.entry.kind === 'rule_source' && item.entry.relative_path === relative);
    const item = frozen ?? artifact('rule_source', relative, await readBoundFile(root, relative));
    if (item.entry.sha256 !== hash) throw new Dnd35BoundaryError('SOURCE_HASH_MISMATCH', 'Source hash mismatch');
    sources.push(item);
  }
  const artifacts = [...segments, ...sources];
  return { artifacts, events: validateBoundary(artifacts, campaignId) };
}
