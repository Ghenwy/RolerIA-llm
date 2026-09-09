# GENERATED FILE - DO NOT EDIT. source=internal/rule-source-record.schema.json schema_sha256=8242a47ff0b994a32beb6bbd38bec8a7f9448b240ae1f2755c29fb9def8d305d

from __future__ import annotations

from enum import Enum
from typing import Literal

from pydantic import BaseModel, ConfigDict, RootModel, constr


class SourceKind(Enum):
    HOUSE_RULE = 'HOUSE_RULE'
    OFFICIAL_ERRATA = 'OFFICIAL_ERRATA'
    SRD_OGC = 'SRD_OGC'
    PERSISTED_RULING = 'PERSISTED_RULING'
    USER_OWNED_EXCERPT = 'USER_OWNED_EXCERPT'


class AllowedScopeItem(RootModel[constr(min_length=1)]):
    root: constr(min_length=1)


class RuleSourceRecordV1(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
        regex_engine="python-re",
    )
    schema_version: Literal['1.0']
    source_id: constr(pattern=r'^SOURCE-[A-Za-z0-9][A-Za-z0-9._-]*$')
    source_kind: SourceKind
    title: constr(min_length=1)
    edition: str | None
    version_or_date: str | None
    ownership_assertion: str | None
    local_excerpt_ref: (
        constr(pattern=r'^(?![A-Za-z]:)(?![/\\])(?!.*(?:^|[/\\])\.\.(?:[/\\]|$)).+$')
        | None
    )
    allowed_scope: list[AllowedScopeItem]
    content_sha256: constr(pattern=r'^[a-f0-9]{64}$') | None
    public_distribution_allowed: bool
    enabled: bool
