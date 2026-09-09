import { validateC3TurnInput, type LlmRequestOptions, type TurnContextPacket } from '@nyx/application';
import { runtimeContractSchema, validateRuntimeContract, type DesignTurnEnvelope } from '@nyx/contracts';

// llama.cpp compiles pattern before maxLength and rejects \s inside character classes.
// Keep the existing 1-3 sentence boundary below the unchanged 1200-character transport maximum.
// Pattern classes become raw GBNF: exclude JSON delimiters and controls; use guillemets/curly quotes.
export const NARRATION_SENTENCE_PATTERN = String.raw`^[^.!?…"\\\x00-\x1F\x7F]{1,350}[.!?][»”']?( ?[^.!?…"\\\x00-\x1F\x7F]{1,350}[.!?][»”']?){0,2}$`;

// Alpha dialogue uses dashes: avoiding paired quote syntax is simpler than a second grammar/repair pass.
// Historical RESOLVE generation and the stored NarrationProposal schema retain their prior language.
const ASSISTED_SENTENCE_PATTERN = String.raw`^[^'‘’«»“”.!?…"\\\x00-\x1F\x7F]{1,350}[.!?]( ?[^'‘’«»“”.!?…"\\\x00-\x1F\x7F]{1,350}[.!?]){0,2}$`;

/** Generation overlay only; do not narrow historical NarrationProposal transport data. */
export function narrationGenerationSchema(): object {
  const schema = runtimeContractSchema('NarrationProposal') as {
    properties: { narration: Record<string, unknown> }
  };
  schema.properties.narration['pattern'] = ASSISTED_SENTENCE_PATTERN;
  return schema;
}

/** [DESIGN DEC-081] Separate profile instructions; protected historical GM prompts remain intact. */
export const ASSISTED_NARRATION_PROMPT =
  'Eres el narrador y las voces de los NPC de una partida en español. Responde primero al mensaje actual. ' +
  'Conserva sus nombres, hechos, ubicación y conocimientos confirmados; no reveles secretos ni decidas por el jugador. ' +
  'No añadas palabras, acciones, pensamientos ni réplicas del personaje jugador. Termina con la reacción solicitada. ' +
  'Puedes crear diálogo y atmósfera coherentes. Una pista sin respuesta registrada es desconocida: el NPC lo admite, no inventa una explicación. ' +
  'No afirmes qué entiende o siente el jugador. ' +
  'La conversación no cambia inventario, salud, ubicación ni conocimiento canónico. No inventes tiradas, reglas ni efectos. ' +
  'Devuelve sólo {"narration":"..."}: una a tres frases completas, breves y naturales; máximo 1200 caracteres. ' +
  'Usa rayas para el diálogo, sin comillas. No uses puntos suspensivos ni palabras truncadas.';

export const NARRATION_RETRY_INSTRUCTION =
  'Reintento único: devuelve sólo un objeto JSON con narration, sin otras propiedades. ' +
  'Conserva los hechos y responde al mensaje actual en una a tres frases completas de hasta 1200 caracteres, sin comillas.';

function narrativeView(packet: TurnContextPacket): unknown {
  if (!('sections' in packet)) return packet; // Legacy packet compatibility, not a new public-scope authorization.
  return { sections: packet.sections
    .filter(section => section.id !== 'current_player_message' && section.id !== 'campaign_profile_language')
    .map(section => {
      if (section.id !== 'current_scene_state' || typeof section.value !== 'object' || section.value === null) return section;
      const value = section.value as Record<string, unknown>;
      if (typeof value['world'] !== 'object' || value['world'] === null || Array.isArray(value['world'])) return section;
      // These are code-only action registries, not the narrative facts describing trips or combat.
      const world = Object.fromEntries(Object.entries(value['world']).filter(([key]) =>
        !['mechanical_actions', 'mechanical_targets', 'travel_routes'].includes(key)));
      return { ...section, value: { ...value, world } };
    }) };
}

export function buildNarrationInput(
  envelope: DesignTurnEnvelope.TurnEnvelopeV1,
  options: LlmRequestOptions,
  contextPacket: TurnContextPacket
) {
  try {
    const valid = validateRuntimeContract('TurnEnvelope', envelope);
    if (!valid.ok) return { ok: false as const, errors: valid.errors };
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0 || !options.correlationId
      || options.candidateRejection !== undefined || options.turnPlan !== undefined
      || options.workerAttempt !== undefined || options.mechanicalAction !== undefined) {
      return { ok: false as const, errors: ['narration:request_options'] };
    }
    const errors = validateC3TurnInput(envelope, contextPacket);
    const currentMessage = 'sections' in contextPacket
      ? contextPacket.sections.find(section => section.id === 'current_player_message')?.value
      : envelope.player_input;
    if (typeof currentMessage !== 'string' || currentMessage.length === 0
      || (envelope.phase === 'PLAN' && currentMessage !== envelope.player_input)) {
      errors.push('narration:current_message_mismatch');
    }
    return errors.length > 0 ? { ok: false as const, errors } : {
      ok: true as const,
      value: { context_packet: narrativeView(contextPacket), player_input: currentMessage, language: envelope.language }
    };
  } catch {
    return { ok: false as const, errors: ['narration:invalid_context'] };
  }
}

// Presentation only: matching punctuation does not certify factual or narrative quality.
export function balancedDialogue(text: string): boolean {
  const closes: Record<string, string> = { '«': '»', '“': '”' };
  const stack: string[] = [];
  for (const char of text) {
    if (closes[char] !== undefined) stack.push(closes[char]);
    else if ((char === '»' || char === '”') && stack.pop() !== char) return false;
  }
  return stack.length === 0;
}
