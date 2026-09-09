# GENERATED FILE - DO NOT EDIT. source=internal/writer-lock.schema.json schema_sha256=3a3b1a6486746f3d7d59270e8045022a3e124a03486a6acea5c6a01df444f9f1

from __future__ import annotations

from enum import Enum
from typing import Literal

from pydantic import AwareDatetime, BaseModel, ConfigDict, conint, constr


class OwnerRuntime(Enum):
    typescript = 'typescript'
    python = 'python'


class WriterLockV1(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    schema_version: Literal['1.0']
    lock_token: constr(min_length=32)
    campaign_id: constr(pattern=r'^CAMPAIGN-[A-Za-z0-9][A-Za-z0-9._-]*$')
    branch_id: constr(pattern=r'^BRANCH-[A-Za-z0-9][A-Za-z0-9._-]*$')
    owner_runtime: OwnerRuntime
    pid: conint(ge=1)
    checkpoint_id: constr(pattern=r'^CHECKPOINT-[A-Za-z0-9][A-Za-z0-9._-]*$')
    state_sha256: constr(pattern=r'^[a-f0-9]{64}$')
    acquired_at: AwareDatetime
