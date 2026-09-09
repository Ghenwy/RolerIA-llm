export type PersistenceErrorCode =
  | 'INVALID_STATE'
  | 'INVALID_EVENT'
  | 'INVALID_TRANSACTION'
  | 'STALE_STATE'
  | 'CANDIDATE_HASH_MISMATCH'
  | 'EVENT_ID_CONFLICT'
  | 'RECORD_ID_CONFLICT'
  | 'CHECKPOINT_HASH_MISMATCH'
  | 'LOCK_HELD'
  | 'LOCK_TOKEN_MISMATCH'
  | 'LOCK_OWNER_ALIVE'
  | 'LOCK_VERIFICATION_FAILED'
  | 'NOT_FOUND'
  | 'CORRUPT_DATA'
  | 'IO_ERROR';

export interface PersistenceError {
  code: PersistenceErrorCode;
  message: string;
  details?: string[];
}

export type TransactionFaultPoint =
  | 'AFTER_PREPARED'
  | 'AFTER_STATE_RENAMED'
  | 'AFTER_EVENTS_APPENDED'
  | 'AFTER_COMMITTED';

export class InjectedTransactionFault extends Error {
  constructor(readonly point: TransactionFaultPoint) {
    super(`Injected transaction fault at ${point}`);
    this.name = 'InjectedTransactionFault';
  }
}

export interface JsonCampaignStoreOptions {
  fault_injector?: (point: TransactionFaultPoint) => void;
}

export type CompactionFaultPoint = 'AFTER_PREPARED' | 'AFTER_ACTIVATED';

export class InjectedCompactionFault extends Error {
  constructor(readonly point: CompactionFaultPoint) {
    super(`Injected compaction fault at ${point}`);
    this.name = 'InjectedCompactionFault';
  }
}

export interface JsonCompactionStoreOptions {
  branch_id?: string;
  fault_injector?: (point: CompactionFaultPoint) => void;
}

export type CheckpointFaultPoint =
  | 'AFTER_STATE_WRITTEN'
  | 'AFTER_EVENTS_WRITTEN'
  | 'AFTER_ARTIFACTS_WRITTEN'
  | 'BEFORE_BRANCH_TIMELINE'
  | 'AFTER_MANIFEST_WRITTEN'
  | 'AFTER_RENAMED';

export class InjectedCheckpointFault extends Error {
  constructor(readonly point: CheckpointFaultPoint) {
    super(`Injected checkpoint fault at ${point}`);
    this.name = 'InjectedCheckpointFault';
  }
}

export interface CheckpointStoreOptions {
  fault_injector?: (point: CheckpointFaultPoint) => void;
}

export interface CompactionRecoverySummary {
  active_commit_id: string | null;
  removed_temporaries: string[];
}

export interface RecoverySummary {
  completed_transactions: string[];
  rolled_back_transactions: string[];
  removed_temporaries: string[];
  repaired_event_logs: string[];
}
