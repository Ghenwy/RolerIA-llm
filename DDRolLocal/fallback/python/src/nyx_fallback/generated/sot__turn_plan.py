# GENERATED FILE - DO NOT EDIT. source=sot/turn-plan.schema.json schema_sha256=78d245578bdec074cc4cc3de9d2cbb0ded6cd0a0400eca110200332c0cb8beb6

from __future__ import annotations

from enum import Enum
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, conint, constr


class PlayerIntent(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    declared_action: str
    target: str | None
    desired_outcome: str | None
    ambiguities: list[str]


class Decision(Enum):
    DIRECT = 'DIRECT'
    DELEGATE = 'DELEGATE'
    ASK_CLARIFICATION = 'ASK_CLARIFICATION'
    BLOCKED = 'BLOCKED'


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


class Job(BaseModel):
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


class Safety(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    player_agency_preserved: bool
    secret_boundaries_preserved: bool


class TurnPlan(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    schema_version: Literal['1.0']
    turn_id: str
    base_state_version: conint(ge=0)
    player_intent: PlayerIntent
    decision: Decision
    jobs: list[Job] = Field(..., max_length=8)
    blocking_job_ids: list[str]
    preconditions: list[str]
    safety: Safety
