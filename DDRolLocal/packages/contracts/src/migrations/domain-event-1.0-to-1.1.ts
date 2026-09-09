import type { InternalDomainEvent, InternalDomainEventV11 } from '../generated/index.js';

type DomainEventV1 = InternalDomainEvent.DomainEventV1;
type DomainEventV11 = InternalDomainEventV11.DomainEventV11;

export interface DomainEventV11Metadata {
  turn_id: string;
  actor_id: string;
  targets: string[];
  campaign_time: string;
  committed: true;
  evidence: [string, ...string[]];
}

/**
 * [DESIGN] v1.0 was a pre-persistence scaffold. Its missing SOT metadata must
 * be supplied explicitly; the migration never fabricates actor or evidence.
 */
export function migrateDomainEventV1ToV11(event: DomainEventV1, metadata: DomainEventV11Metadata): DomainEventV11 {
  if (event.source_refs.length === 0) throw new Error('DomainEvent 1.0 sin source_refs no es migrable.');
  return {
    ...event,
    schema_version: '1.1',
    event_type: event.event_type as DomainEventV11['event_type'],
    source_refs: event.source_refs as [string, ...string[]],
    ...metadata
  };
}
