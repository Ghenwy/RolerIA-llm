import { validateRuntimeContract, type InternalKnowledgeAcquisitionV1 } from '@nyx/contracts';
import { canonicalJson } from '../canonical-json.js';
import { err, ok, type Result } from '../result.js';
import type { CampaignState } from '../state/types.js';

type Proof = InternalKnowledgeAcquisitionV1.KnowledgeAcquisitionV1;
const fail = (code: string) => err({ code, message: `Adquisición de conocimiento bloqueada: ${code}.` });
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function own(value: unknown, key: unknown): unknown {
  return record(value) && typeof key === 'string' && Object.hasOwn(value, key) ? value[key] : undefined;
}
function textOf(value: unknown): string | undefined {
  const text = own(value, 'text');
  return typeof text === 'string' && text.length > 0 ? text : undefined;
}

/** New event admission only, never replay/migration. Sources are resolved against the confirmed
 * pre-transaction snapshot: a proposal cannot manufacture a source earlier in the same batch.
 * Exact receipts bind acquisition to visible communication, without an NLP entailment engine.
 */
export function validateNewKnowledgeEvents(state: CampaignState, events: readonly unknown[], narration: string,
  playerInput: string): Result<true, { code: string; message: string }> {
  const learning = events.filter(event => own(event, 'event_type') === 'NPC_KNOWLEDGE_ADDED');
  if (learning.length === 0) return ok(true);
  if (learning.length !== events.length) return fail('KNOWLEDGE_MIXED_TRANSACTION');
  const present = Array.isArray(state.scene['present_character_ids']) ? state.scene['present_character_ids'] : [];
  const receipts: string[] = [];
  const learned = new Set<string>();
  for (const candidate of learning) {
    if (!record(candidate) || !record(candidate['payload'])) return fail('KNOWLEDGE_PROVENANCE_REQUIRED');
    const p = candidate['payload'];
    if (Object.keys(p).sort().join(',') !== 'acquisition,knowledge_id,subject_id,value'
      || !validateRuntimeContract('KnowledgeAcquisition', p['acquisition']).ok) return fail('KNOWLEDGE_PROVENANCE_REQUIRED');
    const proof = p['acquisition'] as Proof;
    const subject = p['subject_id'];
    const receiver = own(state.characters, subject);
    const receiverName = own(own(receiver, 'sheet'), 'name');
    if (typeof subject !== 'string' || !record(receiver) || !present.includes(subject)
      || typeof receiverName !== 'string' || !receiverName.length) return fail('KNOWLEDGE_SOURCE_UNCONFIRMED');
    const receiverKnowledge = own(state.knowledge, subject);
    const identity = `${subject}:${canonicalJson(p['value'])}`;
    if (typeof p['knowledge_id'] !== 'string' || own(receiverKnowledge, p['knowledge_id']) !== undefined || learned.has(identity)
      || (record(receiverKnowledge) && Object.values(receiverKnowledge).some(value => canonicalJson(value) === canonicalJson(p['value'])))) {
      return fail('KNOWLEDGE_ALREADY_ACQUIRED');
    }
    learned.add(identity);
    let expected: unknown;
    let text: string | undefined;
    let reference: string;
    let receipt: string;
    if (proof.kind === 'DISCLOSURE') {
      const source = own(state.characters, proof.source_subject_id);
      const sourceName = own(own(source, 'sheet'), 'name');
      expected = own(own(state.knowledge, proof.source_subject_id), proof.source_id);
      text = textOf(expected);
      if (!record(source) || typeof sourceName !== 'string' || !sourceName.length || !text
        || !present.includes(proof.source_subject_id) || proof.source_subject_id === subject
        || candidate['actor_id'] !== proof.source_subject_id) return fail('KNOWLEDGE_SOURCE_UNCONFIRMED');
      const secretId = own(expected, 'secret_id');
      if (secretId !== undefined) {
        const secret = own(state.canon.secrets, secretId);
        const audience = own(secret, 'authorized_subject_ids');
        const readers = Object.values(state.characters).filter(character => character.kind === 'player').map(character => character.character_id);
        if (!Array.isArray(audience) || ![subject, proof.source_subject_id, ...readers].every(id => audience.includes(id))) {
          return fail('KNOWLEDGE_AUDIENCE_BLOCKED');
        }
      }
      reference = `knowledge:${proof.source_subject_id}:${proof.source_id}`;
      receipt = `${sourceName} dice en privado a ${receiverName}: «${text}»`;
      if (own(source, 'kind') === 'player' && playerInput !== receipt) return fail('KNOWLEDGE_PLAYER_AGENCY_BLOCKED');
    } else {
      const fact = own(state.canon.facts, proof.source_id);
      text = textOf(fact);
      if (proof.source_subject_id !== null || !record(fact) || !text || fact['visibility'] !== 'public'
        || typeof fact['location_id'] !== 'string' || fact['location_id'] !== state.scene['location_id']
        || fact['location_id'] !== state.world['location_id'] || candidate['actor_id'] !== subject) return fail('KNOWLEDGE_SOURCE_UNCONFIRMED');
      expected = { fact_id: proof.source_id, text };
      reference = `canon:${proof.source_id}`;
      receipt = `${receiverName} observa: «${text}»`;
    }
    if (canonicalJson(p['value']) !== canonicalJson(expected)) return fail('KNOWLEDGE_CLAIM_MISMATCH');
    if (!Array.isArray(candidate['source_refs']) || !candidate['source_refs'].includes(reference)
      || !Array.isArray(candidate['evidence']) || !candidate['evidence'].includes(reference)
      || !Array.isArray(candidate['targets']) || !candidate['targets'].includes(subject)) return fail('KNOWLEDGE_SOURCE_UNCONFIRMED');
    receipts.push(receipt);
  }
  return narration === receipts.join(' ') ? ok(true) : fail('KNOWLEDGE_NARRATION_MISMATCH');
}
