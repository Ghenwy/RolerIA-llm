# GENERATED FILE - DO NOT EDIT. source=design/fallback-handoff.schema.json schema_sha256=c59838e9002616686cfcec731259085224b4e76fea40baba8ac86b55ad52e1dd

from __future__ import annotations

from enum import Enum
from typing import Literal

from pydantic import BaseModel, ConfigDict, RootModel, conint, constr


class SourceRuntime(Enum):
    typescript = 'typescript'
    python = 'python'


class TargetRuntime(Enum):
    typescript = 'typescript'
    python = 'python'


class Sha256(RootModel[constr(pattern=r'^[a-f0-9]{64}$')]):
    root: constr(pattern=r'^[a-f0-9]{64}$')


class FallbackHandoffV1(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    schema_version: Literal['1.0']
    campaign_id: constr(pattern=r'^CAMPAIGN-[A-Za-z0-9][A-Za-z0-9._-]*$')
    branch_id: constr(pattern=r'^BRANCH-[A-Za-z0-9][A-Za-z0-9._-]*$')
    committed_state_version: conint(ge=0)
    checkpoint_id: constr(pattern=r'^CHECKPOINT-[A-Za-z0-9][A-Za-z0-9._-]*$')
    event_tail_hash: Sha256
    rng_hash: Sha256
    source_runtime: SourceRuntime
    target_runtime: TargetRuntime
    reason: constr(min_length=1, max_length=2048)
    integrity_status: Literal['PASS']
    foreign_writer_lock_present: Literal[False]
