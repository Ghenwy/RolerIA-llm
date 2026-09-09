# GENERATED FILE - DO NOT EDIT. source=design/runtime-profile.schema.json schema_sha256=106a3b2ff91219de49489c852d5226a554335c5714d63bbbf17b1757cbf39228

from __future__ import annotations

from enum import Enum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, conint, constr


class Profile(Enum):
    field_96k = '96k'
    field_112k = '112k'


class ContextPerSlot(Enum):
    int_98304 = 98304
    int_114688 = 114688


class Override(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    key: constr(min_length=1)
    value: Any
    reason: constr(min_length=1)


class RuntimeProfileV1(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    schema_version: Literal['1.0']
    profile: Profile
    context_per_slot: ContextPerSlot
    parallel: Literal[3]
    cache_type_k: Literal['Q5_1']
    cache_type_v: Literal['Q5_1']
    batch: conint(ge=1)
    ubatch: conint(ge=1)
    fit: Literal[True]
    fit_target_mib: conint(ge=1)
    host: Literal['127.0.0.1']
    port: conint(ge=1, le=65535)
    overrides: list[Override]
