# GENERATED FILE - DO NOT EDIT. source=internal/worker-attempt.schema.json schema_sha256=200a0ad54a1da51058973719933de37add4bb5d4675d38118d763a338e53fe83

from __future__ import annotations

from enum import Enum
from typing import Literal

from pydantic import BaseModel, ConfigDict, conint, constr


class Status(Enum):
    RUNNING = 'RUNNING'
    COMPLETED = 'COMPLETED'
    PARTIAL = 'PARTIAL'
    BLOCKED = 'BLOCKED'
    FAILED = 'FAILED'
    STALE = 'STALE'
    CANCELLED = 'CANCELLED'


class WorkerAttemptV1(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    schema_version: Literal['1.0']
    attempt_id: constr(pattern=r'^ATTEMPT-[a-f0-9]{64}$')
    campaign_id: constr(pattern=r'^CAMPAIGN-[A-Za-z0-9][A-Za-z0-9._-]*$')
    turn_id: constr(pattern=r'^TURN-[A-Za-z0-9][A-Za-z0-9._-]*$')
    job_id: constr(pattern=r'^JOB-[A-Za-z0-9][A-Za-z0-9._-]*$')
    ordinal: conint(ge=1)
    status: Status
    reason_code: constr(pattern=r'^[A-Z0-9_:-]+$', min_length=1, max_length=96)
    retry_authorized: bool
