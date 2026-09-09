# GENERATED FILE - DO NOT EDIT. source=sot/rule-query.schema.json schema_sha256=884f7179e8b4b11bf449810393f91c71c0e95f8367b20c9b9db21cda30038bc1

from __future__ import annotations

from enum import Enum
from typing import Literal

from pydantic import BaseModel, ConfigDict, conint, constr


class SourceScope(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    allowed_source_ids: list[str]
    house_rule_ids: list[str]
    closed_source_excerpts: list[str]


class RequestedResolution(Enum):
    eligibility = 'eligibility'
    action_legality = 'action_legality'
    roll_formula = 'roll_formula'
    outcome = 'outcome'
    progression = 'progression'
    interaction = 'interaction'
    source_lookup = 'source_lookup'


class Model(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    query_id: str
    ruleset_id: Literal['dnd35_srd_ogc']
    state_version: conint(ge=0)
    question: constr(min_length=5)
    actors: list[str]
    facts: list[str]
    source_scope: SourceScope
    requested_resolution: RequestedResolution
