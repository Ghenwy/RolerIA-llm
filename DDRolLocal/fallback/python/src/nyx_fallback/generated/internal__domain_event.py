# GENERATED FILE - DO NOT EDIT. source=internal/domain-event.schema.json schema_sha256=e5face97e57cc84e4ffd2d6ea6eab6cc00407827c2b82967179c2411b77db76f

from __future__ import annotations

from typing import Any, Literal

from pydantic import AwareDatetime, BaseModel, ConfigDict, RootModel, conint, constr


class SourceRef(RootModel[constr(min_length=1)]):
    root: constr(min_length=1)


class DomainEventV1(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    schema_version: Literal['1.0']
    event_id: constr(pattern=r'^EVENT-[A-Za-z0-9][A-Za-z0-9._-]*$')
    event_type: constr(pattern=r'^[A-Z][A-Z0-9_]*$')
    campaign_id: constr(pattern=r'^CAMPAIGN-[A-Za-z0-9][A-Za-z0-9._-]*$')
    branch_id: constr(pattern=r'^BRANCH-[A-Za-z0-9][A-Za-z0-9._-]*$')
    base_state_version: conint(ge=0)
    committed_state_version: conint(ge=1)
    correlation_id: constr(min_length=1)
    occurred_at: AwareDatetime
    payload: dict[str, Any]
    source_refs: list[SourceRef]
