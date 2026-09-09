# GENERATED FILE - DO NOT EDIT. source=sot/rpgworker-result.schema.json schema_sha256=9813563934457426e0619efcb4d5eed2290692b99fee3a7614efbb3f8b3f7e69

from __future__ import annotations

from enum import Enum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, confloat, conint


class Status(Enum):
    completed = 'completed'
    partial = 'partial'
    blocked = 'blocked'
    failed = 'failed'
    stale = 'stale'


class Certainty(Enum):
    certain = 'certain'
    high = 'high'
    medium = 'medium'
    low = 'low'


class Finding(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    claim: str
    evidence: list[str]
    certainty: Certainty


class Dod(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    passed: bool
    missing: list[str]


class RPGWorkerResult(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    schema_version: Literal['1.0']
    job_id: str
    turn_id: str
    worker_id: str
    base_state_version: conint(ge=0)
    status: Status
    summary: str
    findings: list[Finding]
    proposed_events: list[dict[str, Any]]
    proposed_patches: list[dict[str, Any]]
    narrative_material: dict[str, Any]
    memory_candidates: list[dict[str, Any]]
    unresolved: list[str]
    confidence: confloat(ge=0.0, le=1.0)
    dod: Dod
