# GENERATED FILE - DO NOT EDIT. source=design/turn-envelope.schema.json schema_sha256=d6ecf6649c8c5db90fc5566934cf728a8f8fa1107e4d4cf717c71cd2897bd578

from __future__ import annotations

from enum import Enum
from typing import Literal

from pydantic import BaseModel, ConfigDict, RootModel, conint, constr


class Phase(Enum):
    PLAN = 'PLAN'
    RESOLVE = 'RESOLVE'


class Sha256(RootModel[constr(pattern=r'^[a-f0-9]{64}$')]):
    root: constr(pattern=r'^[a-f0-9]{64}$')


class ContentRef(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    id: constr(min_length=1, max_length=256)
    sha256: Sha256


class ResultRef(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    job_id: constr(min_length=1)
    worker_id: constr(min_length=1)
    base_state_version: conint(ge=0)
    status: Literal['COMPLETED']
    sha256: Sha256


class RollRef(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    roll_id: constr(min_length=1)
    expression: constr(min_length=1)
    result: int
    rng_counter: conint(ge=0)


class TurnEnvelopeV1(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    schema_version: Literal['1.0']
    campaign_id: constr(
        pattern=r'^CAMPAIGN-[A-Za-z0-9][A-Za-z0-9._-]*$', max_length=128
    )
    turn_id: constr(pattern=r'^TURN-[A-Za-z0-9][A-Za-z0-9._-]*$', max_length=128)
    phase: Phase
    base_state_version: conint(ge=0)
    player_input: constr(max_length=32768) | None
    context_refs: list[ContentRef]
    worker_results: list[ResultRef]
    deterministic_rolls: list[RollRef]
    language: constr(pattern=r'^[a-z]{2}(?:-[A-Z]{2})?$')
