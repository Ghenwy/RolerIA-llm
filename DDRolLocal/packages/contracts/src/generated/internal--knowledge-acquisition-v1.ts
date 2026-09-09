/* GENERATED FILE - DO NOT EDIT. source=internal/knowledge-acquisition-v1.schema.json schema_sha256=06c3651a5cf409e0218f013cdda623a565f47de47550a1e3d52ca9d2918d4fe0 */

/**
 * [DESIGN] Provenance required only at new knowledge-event admission. Historical DomainEvent/replay remain unchanged. REQ-ST-007, IMP-C09-T03.
 */
export interface KnowledgeAcquisitionV1 {
  schema_version: '1.0';
  kind: 'DISCLOSURE' | 'OBSERVATION';
  source_subject_id: string | null;
  source_id: string;
}
