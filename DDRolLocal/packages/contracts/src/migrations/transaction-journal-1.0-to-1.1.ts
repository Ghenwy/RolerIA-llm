import type { InternalTransactionJournal, InternalTransactionJournalV11 } from '../generated/index.js';

export function migrateTransactionJournalV1ToV11(
  journal: InternalTransactionJournal.TransactionJournalV1
): InternalTransactionJournalV11.TransactionJournalV11 {
  return { ...journal, schema_version: '1.1' };
}
