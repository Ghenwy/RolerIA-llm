# GENERATED FILE - DO NOT EDIT. source=internal/memory-record.schema.json schema_sha256=d34c150576b4157c86f42769dd9d30e484e0642c494cfb55741cc09e1bc0e27d

from __future__ import annotations

from enum import Enum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, RootModel, conint, constr


class RetentionClass(Enum):
    EXACT = 'EXACT'
    DURABLE = 'DURABLE'
    EPISODIC = 'EPISODIC'
    EVICTABLE = 'EVICTABLE'


class SourceRef(RootModel[constr(min_length=1)]):
    root: constr(min_length=1)


class MemoryRecordV1(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    schema_version: Literal['1.0']
    memory_id: constr(pattern=r'^MEMORY-[A-Za-z0-9][A-Za-z0-9._-]*$')
    campaign_id: constr(pattern=r'^CAMPAIGN-[A-Za-z0-9][A-Za-z0-9._-]*$')
    branch_id: constr(pattern=r'^BRANCH-[A-Za-z0-9][A-Za-z0-9._-]*$')
    retention_class: RetentionClass
    content: dict[str, Any]
    source_refs: list[SourceRef] = Field(..., min_length=1)
    created_state_version: conint(ge=0)
    updated_state_version: conint(ge=0)
    exact_payload_sha256: constr(pattern=r'^[a-f0-9]{64}$') | None
