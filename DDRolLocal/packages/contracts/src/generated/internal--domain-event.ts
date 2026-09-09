/* GENERATED FILE - DO NOT EDIT. source=internal/domain-event.schema.json schema_sha256=e5face97e57cc84e4ffd2d6ea6eab6cc00407827c2b82967179c2411b77db76f */

export interface DomainEventV1 {
  schema_version: '1.0';
  event_id: string;
  event_type: string;
  campaign_id: string;
  branch_id: string;
  base_state_version: number;
  committed_state_version: number;
  correlation_id: string;
  occurred_at: string;
  payload: {
    [k: string]: any;
  };
  source_refs: string[];
}
