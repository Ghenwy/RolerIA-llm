# GENERATED FILE - DO NOT EDIT. source=internal/worker-queue-batch.schema.json schema_sha256=27b562f74c9b6ad1174076ea6071f5fa0d90f3b63f053ae2cc0e9b8551f01670

from __future__ import annotations

from enum import Enum
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, RootModel, conint, constr


class JobId(RootModel[constr(pattern=r'^JOB-[A-Za-z0-9][A-Za-z0-9._-]*$')]):
    root: constr(pattern=r'^JOB-[A-Za-z0-9][A-Za-z0-9._-]*$')


class Status(Enum):
    PREPARED = 'PREPARED'
    COMMITTED = 'COMMITTED'


class WorkerQueueBatchV1(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    schema_version: Literal['1.0']
    batch_id: constr(pattern=r'^BATCH-[a-f0-9]{64}$')
    campaign_id: constr(pattern=r'^CAMPAIGN-[A-Za-z0-9][A-Za-z0-9._-]*$')
    turn_id: constr(pattern=r'^TURN-[A-Za-z0-9][A-Za-z0-9._-]*$')
    base_state_version: conint(ge=0)
    job_ids: list[JobId] = Field(..., min_length=1)
    status: Status
