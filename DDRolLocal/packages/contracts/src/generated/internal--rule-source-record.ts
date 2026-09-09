/* GENERATED FILE - DO NOT EDIT. source=internal/rule-source-record.schema.json schema_sha256=8242a47ff0b994a32beb6bbd38bec8a7f9448b240ae1f2755c29fb9def8d305d */

export type RuleSourceRecordV1 = {
  schema_version: '1.0';
  source_id: string;
  source_kind: 'HOUSE_RULE' | 'OFFICIAL_ERRATA' | 'SRD_OGC' | 'PERSISTED_RULING' | 'USER_OWNED_EXCERPT';
  title: string;
  edition: string | null;
  version_or_date: string | null;
  ownership_assertion: string | null;
  local_excerpt_ref: string | null;
  allowed_scope: string[];
  content_sha256: string | null;
  public_distribution_allowed: boolean;
  enabled: boolean;
};
