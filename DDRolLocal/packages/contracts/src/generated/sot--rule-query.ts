/* GENERATED FILE - DO NOT EDIT. source=sot/rule-query.schema.json schema_sha256=884f7179e8b4b11bf449810393f91c71c0e95f8367b20c9b9db21cda30038bc1 */

export interface UrnNyxRpgDnd35RuleQuery10 {
  query_id: string;
  ruleset_id: 'dnd35_srd_ogc';
  state_version: number;
  question: string;
  actors: string[];
  facts: string[];
  source_scope: {
    allowed_source_ids: string[];
    house_rule_ids: string[];
    closed_source_excerpts: string[];
  };
  requested_resolution:
    'eligibility' | 'action_legality' | 'roll_formula' | 'outcome' | 'progression' | 'interaction' | 'source_lookup';
}
