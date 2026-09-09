/* GENERATED FILE - DO NOT EDIT. source=sot/turn-resolution.schema.json schema_sha256=44e3ad77f2165d58fa10af18ef41cf1de34cd97b7690a5ed0d4a5716e2acffa8 */

export interface TurnResolution {
  schema_version: '1.0';
  turn_id: string;
  base_state_version: number;
  resolution_status: 'READY' | 'AWAITING_ROLL' | 'AWAITING_WORKER' | 'BLOCKED';
  required_rolls: {
    [k: string]: any;
  }[];
  events_to_commit: {
    [k: string]: any;
  }[];
  patches_to_commit: {
    [k: string]: any;
  }[];
  player_facing_narration: string;
  open_threads: {
    [k: string]: any;
  }[];
  memory_signals: {
    [k: string]: any;
  }[];
  checkpoint_recommended: boolean;
}
