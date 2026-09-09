/* GENERATED FILE - DO NOT EDIT. source=design/guided-turn-intent-v1.schema.json schema_sha256=7d87adfd5b58e62ff582e7ad7dc05e2edc47ef4f316d91c369a04a1eeba1a786 */

/**
 * [DESIGN DEC-081] Explicit assisted intent constructed by application code, never by the model. IDs select registered capabilities; free text does not grant authority.
 */
export type GuidedTurnIntentV1 =
  | {
      schema_version: '1.0';
      kind: 'conversation';
      text: Text;
    }
  | {
      schema_version: '1.0';
      kind: 'rule';
      scope: Id;
      question: Text;
    }
  | {
      schema_version: '1.0';
      kind: 'travel';
      route_id: Id;
    }
  | {
      schema_version: '1.0';
      kind: 'action';
      action_id: Id;
      text: string;
    };
export type Text = string;
export type Id = string;
