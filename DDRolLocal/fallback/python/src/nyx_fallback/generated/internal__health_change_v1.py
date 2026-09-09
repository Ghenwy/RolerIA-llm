# GENERATED FILE - DO NOT EDIT. source=internal/health-change-v1.schema.json schema_sha256=1ed27975b4a33863996bbd3935ceffd0b061a78abfa556b5564fe390cf49eee2

from __future__ import annotations

from enum import Enum
from typing import Literal

from pydantic import BaseModel, ConfigDict, conint, constr


class BeforeDeathState(Enum):
    alive = 'alive'
    disabled = 'disabled'
    dying = 'dying'


class AfterDeathState(Enum):
    alive = 'alive'
    disabled = 'disabled'
    dying = 'dying'
    dead = 'dead'


class HealthChangeV1(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    schema_version: Literal['1.0']
    kind: Literal['WEAPON_DAMAGE']
    character_id: constr(min_length=1, max_length=128)
    delta: conint(ge=-9007199254740991, le=-1)
    before_hp: conint(ge=-9, le=9007199254740991)
    after_hp: conint(ge=-9007199254740991, le=9007199254740991)
    before_death_state: BeforeDeathState
    after_death_state: AfterDeathState
