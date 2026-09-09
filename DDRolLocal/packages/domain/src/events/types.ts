import type { InternalDomainEventV11 } from '@nyx/contracts';

export type AtomicEvent = InternalDomainEventV11.DomainEventV11;
export type AtomicEventType = AtomicEvent['event_type'];

export type StateErrorCode =
  | 'INVALID_EVENT'
  | 'DUPLICATE_EVENT'
  | 'STALE_STATE_VERSION'
  | 'VERSION_SEQUENCE_INVALID'
  | 'CAMPAIGN_MISMATCH'
  | 'BRANCH_MISMATCH'
  | 'UNRESOLVED_REFERENCE'
  | 'INVARIANT_VIOLATION'
  | 'UNSUPPORTED_EVENT';

export interface StateError {
  code: StateErrorCode;
  message: string;
  event_id?: string;
  event_index?: number;
}
