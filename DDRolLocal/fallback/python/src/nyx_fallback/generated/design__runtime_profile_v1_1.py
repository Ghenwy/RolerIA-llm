# GENERATED FILE - DO NOT EDIT. source=design/runtime-profile-v1.1.schema.json schema_sha256=d1a239693d935e9735bc33253c6995df67218222b134aae568491f3cbefe2632

from __future__ import annotations

from enum import Enum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, conint, constr


class Profile(Enum):
    field_64k = '64k'
    field_96k = '96k'
    field_112k = '112k'


class ContextPerSlot(Enum):
    int_65536 = 65536
    int_98304 = 98304
    int_114688 = 114688


class Override(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    key: constr(min_length=1)
    value: Any
    reason: constr(min_length=1)


class Environment(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    GGML_CUDA_NO_PINNED: Literal['1']


class Runtime(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    source_revision: constr(pattern=r'^[a-f0-9]{40}$')
    executable: constr(pattern=r'^runtime/(?:[A-Za-z0-9_-]+/)+llama-server\.exe$')
    sha256: constr(pattern=r'^[a-f0-9]{64}$')
    artifacts: dict[
        constr(pattern=r'^[A-Za-z0-9_-]+\.dll$'), constr(pattern=r'^[a-f0-9]{64}$')
    ] = Field(..., min_length=1)
    environment: Environment


class RuntimeProfileV11(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    schema_version: Literal['1.1']
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
    runtime: Runtime | None = None
