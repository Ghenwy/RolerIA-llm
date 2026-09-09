import { validateRuntimeContract, type DesignGuidedTurnIntentV1 } from '@nyx/contracts';
import type { ApplicationPortResult } from '../service/application-service.js';

export type GuidedTurnIntent = DesignGuidedTurnIntentV1.GuidedTurnIntentV1;
export const GUIDED_TURN_USAGE = 'Escribe diálogo, /rule <scope> <pregunta>, /travel <route-id> o /action <action-id> [descripción].';

/** DEC-081: syntax only. The application must still bind IDs to the confirmed campaign. */
export function parseGuidedTurnIntent(input: unknown): ApplicationPortResult<GuidedTurnIntent> {
  const invalid = (code = 'GUIDED_COMMAND_INVALID'): ApplicationPortResult<never> => ({ ok: false,
    error: { code, message: GUIDED_TURN_USAGE } });
  if (typeof input !== 'string' || input.length > 32768 || input.trim().length === 0) return invalid();
  const trimmed = input.trim();
  let intent: unknown;
  if (!trimmed.startsWith('/')) intent = { schema_version: '1.0', kind: 'conversation', text: input };
  else {
    const match = /^\/(rule|travel|action)(?:\s+([\s\S]*))?$/u.exec(trimmed);
    if (match === null) return invalid();
    const kind = match[1]!;
    const argumentsText = match[2]?.trim() ?? '';
    if (argumentsText.length === 0) return invalid('GUIDED_SELECTION_REQUIRED');
    const parts = /^(\S+)(?:\s+([\s\S]*))?$/u.exec(argumentsText)!;
    const selected = parts[1]!, text = parts[2] ?? '';
    if (kind === 'rule') {
      if (text.trim().length === 0) return invalid('GUIDED_SELECTION_REQUIRED');
      intent = { schema_version: '1.0', kind, scope: selected, question: text };
    } else if (kind === 'travel') {
      if (text.length > 0) return invalid();
      intent = { schema_version: '1.0', kind, route_id: selected };
    } else intent = { schema_version: '1.0', kind, action_id: selected, text };
  }
  return validateRuntimeContract('GuidedTurnIntent', intent).ok
    ? { ok: true, value: intent as GuidedTurnIntent } : invalid();
}
