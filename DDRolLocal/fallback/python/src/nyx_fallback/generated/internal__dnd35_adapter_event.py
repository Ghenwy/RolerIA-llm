# GENERATED FILE - DO NOT EDIT. source=internal/dnd35-adapter-event.schema.json schema_sha256=2ff0666da18dce6940adf381245a9753029e3d70539c5e1d0d4923aaa838be38

from __future__ import annotations

from enum import Enum
from typing import Any, Literal

from pydantic import (
    AwareDatetime,
    BaseModel,
    ConfigDict,
    Field,
    RootModel,
    conint,
    constr,
)


class EventType(Enum):
    RACE_OPTION_SELECTED = 'RACE_OPTION_SELECTED'
    RACIAL_HD_APPLIED = 'RACIAL_HD_APPLIED'
    LEVEL_ADJUSTMENT_APPLIED = 'LEVEL_ADJUSTMENT_APPLIED'
    PRESTIGE_ELIGIBILITY_CHECKED = 'PRESTIGE_ELIGIBILITY_CHECKED'
    PRESTIGE_LEVEL_GAINED = 'PRESTIGE_LEVEL_GAINED'
    SPELLCASTING_PROGRESSION_CHOSEN = 'SPELLCASTING_PROGRESSION_CHOSEN'
    MANIFESTING_PROGRESSION_CHOSEN = 'MANIFESTING_PROGRESSION_CHOSEN'
    RACE_VARIANT_CHOSEN = 'RACE_VARIANT_CHOSEN'
    RULE_SOURCE_REGISTERED = 'RULE_SOURCE_REGISTERED'
    RULE_RULING_RECORDED = 'RULE_RULING_RECORDED'
    HOUSE_RULE_ENABLED = 'HOUSE_RULE_ENABLED'
    HOUSE_RULE_DISABLED = 'HOUSE_RULE_DISABLED'


class SourceRef(RootModel[constr(min_length=1)]):
    root: constr(min_length=1)


class Dnd35AdapterEventV1(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    schema_version: Literal['1.0']
    event_id: constr(pattern=r'^DND35-EVENT-[A-Za-z0-9][A-Za-z0-9._-]*$')
    event_type: EventType
    campaign_id: constr(pattern=r'^CAMPAIGN-[A-Za-z0-9][A-Za-z0-9._-]*$')
    branch_id: constr(pattern=r'^BRANCH-[A-Za-z0-9][A-Za-z0-9._-]*$')
    base_adapter_version: conint(ge=0)
    committed_adapter_version: conint(ge=1)
    actor_id: constr(min_length=1)
    occurred_at: AwareDatetime
    payload: dict[str, Any] = Field(..., min_length=1)
    source_refs: list[SourceRef] = Field(..., min_length=1)
