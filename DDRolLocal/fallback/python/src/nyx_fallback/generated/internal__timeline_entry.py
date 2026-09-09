# GENERATED FILE - DO NOT EDIT. source=internal/timeline-entry.schema.json schema_sha256=d9185c433b47957e1e37db4b765a02a8a83b24471444662f355cd903dd1e350f

from __future__ import annotations

from enum import Enum
from typing import Literal

from pydantic import AwareDatetime, BaseModel, ConfigDict, constr


class Type(Enum):
    BRANCH_CREATED = 'BRANCH_CREATED'
    BRANCH_DEACTIVATED = 'BRANCH_DEACTIVATED'


class TimelineEntryV1(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    schema_version: Literal['1.0']
    timeline_event_id: constr(pattern=r'^TIMELINE-[A-Za-z0-9][A-Za-z0-9._-]*$')
    type: Type
    campaign_id: constr(pattern=r'^CAMPAIGN-[A-Za-z0-9][A-Za-z0-9._-]*$')
    branch_id: constr(pattern=r'^BRANCH-[A-Za-z0-9][A-Za-z0-9._-]*$')
    parent_branch_id: constr(pattern=r'^BRANCH-[A-Za-z0-9][A-Za-z0-9._-]*$') | None
    parent_checkpoint_id: (
        constr(pattern=r'^CHECKPOINT-[A-Za-z0-9][A-Za-z0-9._-]*$') | None
    )
    occurred_at: AwareDatetime
