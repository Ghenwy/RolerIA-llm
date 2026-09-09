# GENERATED FILE - DO NOT EDIT. source=sot/turn-resolution.schema.json schema_sha256=44e3ad77f2165d58fa10af18ef41cf1de34cd97b7690a5ed0d4a5716e2acffa8

from __future__ import annotations

from enum import Enum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, conint


class ResolutionStatus(Enum):
    READY = 'READY'
    AWAITING_ROLL = 'AWAITING_ROLL'
    AWAITING_WORKER = 'AWAITING_WORKER'
    BLOCKED = 'BLOCKED'


class TurnResolution(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    schema_version: Literal['1.0']
    turn_id: str
    base_state_version: conint(ge=0)
    resolution_status: ResolutionStatus
    required_rolls: list[dict[str, Any]]
    events_to_commit: list[dict[str, Any]]
    patches_to_commit: list[dict[str, Any]]
    player_facing_narration: str
    open_threads: list[dict[str, Any]]
    memory_signals: list[dict[str, Any]]
    checkpoint_recommended: bool
