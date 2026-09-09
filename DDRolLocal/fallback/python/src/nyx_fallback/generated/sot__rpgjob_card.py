# GENERATED FILE - DO NOT EDIT. source=sot/rpgjob-card.schema.json schema_sha256=0a10565da554f073d85a8f8c068088b28c4d1ce93b9e5d379192dfae97e121a2

from __future__ import annotations

from enum import Enum
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, conint, constr


class Priority(Enum):
    P0 = 'P0'
    P1 = 'P1'
    P2 = 'P2'
    P3 = 'P3'


class WorkerId(Enum):
    rpg_rules_arbiter = 'rpg.rules_arbiter'
    rpg_npc_director = 'rpg.npc_director'
    rpg_world_simulator = 'rpg.world_simulator'
    rpg_encounter_engine = 'rpg.encounter_engine'
    rpg_state_keeper = 'rpg.state_keeper'
    rpg_memory_keeper = 'rpg.memory_keeper'
    rpg_canon_validator = 'rpg.canon_validator'
    rpg_lore_curator = 'rpg.lore_curator'


class Inputs(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    state_refs: list[str]
    event_refs: list[str]
    transcript_refs: list[str]
    rules_refs: list[str]
    facts: list[str]


class ExpectedOutput(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    type: str
    required_fields: list[str]


class DeadlineClass(Enum):
    before_resolution = 'before_resolution'
    before_narration = 'before_narration'
    after_response = 'after_response'
    idle = 'idle'


class Budget(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    max_context_tokens: conint(ge=2048, le=114688)
    max_output_tokens: conint(ge=128, le=16384)
    deadline_class: DeadlineClass


class Status(Enum):
    PENDING = 'PENDING'
    READY = 'READY'
    RUNNING = 'RUNNING'
    COMPLETED = 'COMPLETED'
    PARTIAL = 'PARTIAL'
    BLOCKED = 'BLOCKED'
    FAILED = 'FAILED'
    STALE = 'STALE'
    CANCELLED = 'CANCELLED'


class RPGJobCard(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    schema_version: Literal['1.0']
    job_id: constr(pattern=r'^JOB-[A-Z0-9-]+$')
    turn_id: constr(pattern=r'^TURN-[A-Z0-9-]+$')
    priority: Priority
    worker_id: WorkerId
    objective: constr(min_length=8)
    base_state_version: conint(ge=0)
    inputs: Inputs
    constraints: list[str]
    dependencies: list[str]
    blocking: bool
    expected_output: ExpectedOutput
    definition_of_done: list[str] = Field(..., min_length=1)
    budget: Budget
    status: Status
