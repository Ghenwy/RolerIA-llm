/* GENERATED FILE - DO NOT EDIT. source=sot/inventory.schema.json schema_sha256=c2d3372526e3002ca614b2a1938374055ef14cee9033386f30073996fb3c72a2 */

export interface Inventory {
  schema_version: '1.0';
  inventory_id: string;
  owner_type: 'character' | 'party' | 'location' | 'vehicle' | 'organization';
  owner_id: string;
  version: number;
  currencies: {
    [k: string]: number;
  };
  containers: {
    container_id: string;
    name: string;
    parent_container_id: string | null;
    capacity: number | null;
    location: string;
  }[];
  items: {
    item_instance_id: string;
    template_id: string;
    name: string;
    quantity: number;
    owner_id: string;
    container_id: string | null;
    equipped_slot: string | null;
    weight_each: number;
    identified: boolean;
    charges_current: number | null;
    charges_max: number | null;
    condition: string;
    quest_item: boolean;
    provenance: string[];
    effects: {
      [k: string]: any;
    }[];
    source_ref: string | null;
  }[];
  carrying: {
    total_weight: number;
    light_limit: number | null;
    medium_limit: number | null;
    heavy_limit: number | null;
    load_state: 'light' | 'medium' | 'heavy' | 'overloaded' | 'not_applicable';
  };
}
