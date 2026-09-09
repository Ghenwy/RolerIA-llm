/* GENERATED FILE - DO NOT EDIT. source=sot/rule-resolution.schema.json schema_sha256=7e6be2402dc2225accf645c77aef94da8e3c1b754936aba2e56b47989e151727 */

export interface UrnNyxRpgDnd35RuleResolution10 {
  query_id: string;
  status: 'resolved' | 'partial' | 'blocked' | 'conflict';
  ruling: string;
  sources: {
    source_id: string;
    section: string;
    url: string;
    authority: 'house_rule' | 'official_errata' | 'srd_ogc' | 'campaign_ruling' | 'user_excerpt';
  }[];
  required_rolls: {
    [k: string]: any;
  }[];
  modifiers: {
    [k: string]: any;
  }[];
  resource_changes: {
    [k: string]: any;
  }[];
  state_events: {
    [k: string]: any;
  }[];
  ambiguities: string[];
  confidence: number;
}
