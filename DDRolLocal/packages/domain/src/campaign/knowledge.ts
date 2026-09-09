import { cloneJson } from '../clone.js';
import type { CampaignState } from '../state/types.js';

export interface SubjectKnowledgeView {
  knowledge: Record<string, unknown>;
  beliefs: Record<string, unknown>;
  rumors: Record<string, unknown>;
  authorized_secrets: Record<string, unknown>;
}

export function visibleKnowledgeForSubject(state: CampaignState, subjectId: string): SubjectKnowledgeView {
  const authorizedSecrets = Object.fromEntries(
    Object.entries(state.canon.secrets)
      .filter(([, secret]) => secret.authorized_subject_ids.includes(subjectId))
      .map(([secretId, secret]) => [secretId, cloneJson(secret.value)])
  );
  return {
    knowledge: cloneJson(state.knowledge[subjectId] ?? {}),
    beliefs: cloneJson(state.beliefs[subjectId] ?? {}),
    rumors: cloneJson(state.rumors[subjectId] ?? {}),
    authorized_secrets: authorizedSecrets
  };
}
