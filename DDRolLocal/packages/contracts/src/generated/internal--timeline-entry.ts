/* GENERATED FILE - DO NOT EDIT. source=internal/timeline-entry.schema.json schema_sha256=d9185c433b47957e1e37db4b765a02a8a83b24471444662f355cd903dd1e350f */

export interface TimelineEntryV1 {
  schema_version: '1.0';
  timeline_event_id: string;
  type: 'BRANCH_CREATED' | 'BRANCH_DEACTIVATED';
  campaign_id: string;
  branch_id: string;
  parent_branch_id: string | null;
  parent_checkpoint_id: string | null;
  occurred_at: string;
}
