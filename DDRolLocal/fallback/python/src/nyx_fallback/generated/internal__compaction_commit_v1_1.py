# GENERATED FILE - DO NOT EDIT. source=internal/compaction-commit-v1.1.schema.json schema_sha256=00c7a4afc76eac21d58c8f310a83665893ff19165f62bd3aed98f50ba88f02a7

from __future__ import annotations

from enum import Enum
from typing import Any, Literal

from pydantic import (
    AwareDatetime,
    BaseModel,
    ConfigDict,
    Field,
    RootModel,
    conint,
    constr,
)


class SchemaVersion(Enum):
    field_1_0 = '1.0'
    field_1_1 = '1.1'


class StringSetItem(RootModel[constr(min_length=1)]):
    root: constr(min_length=1)


class StringSet(RootModel[list[StringSetItem]]):
    root: list[StringSetItem]


class TurnRange(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    from_turn: conint(ge=0)
    to_turn: conint(ge=0)


class FingerprintMap(
    RootModel[dict[constr(min_length=1), constr(pattern=r'^[a-f0-9]{64}$')]]
):
    root: dict[constr(min_length=1), constr(pattern=r'^[a-f0-9]{64}$')]


class ContextView(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    schema_version: Literal['1.0']
    campaign_id: constr(pattern=r'^CAMPAIGN-[A-Za-z0-9][A-Za-z0-9._-]*$')
    branch_id: constr(pattern=r'^BRANCH-[A-Za-z0-9][A-Za-z0-9._-]*$')
    base_state_version: conint(ge=0)
    source_context_sha256: constr(pattern=r'^[a-f0-9]{64}$')
    context_sha256: constr(pattern=r'^[a-f0-9]{64}$')
    source_turn_range: TurnRange
    retrieved_memory_ids: StringSet
    recent_transcript_refs: StringSet
    open_threads: list[dict[str, Any]]
    preserved_exact_refs: StringSet


class ValidationManifest(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    pc_sheet_fingerprints: FingerprintMap
    relevant_npc_sheet_fingerprints: FingerprintMap
    party_inventory_fingerprints: FingerprintMap
    character_inventory_fingerprints: FingerprintMap
    quest_fingerprints: FingerprintMap
    canon_sha256: constr(pattern=r'^[a-f0-9]{64}$')
    knowledge_sha256: constr(pattern=r'^[a-f0-9]{64}$')
    pc_sheet_ids_checked: StringSet
    relevant_npc_sheet_ids_checked: StringSet
    party_inventory_ids_checked: StringSet
    character_inventory_ids_checked: StringSet
    quest_ids_checked: StringSet
    canon_checked: Literal[True]
    knowledge_boundaries_checked: Literal[True]
    open_threads_checked: Literal[True]
    source_turn_ids_checked: StringSet
    source_event_ids_checked: StringSet
    source_event_range_covered: Literal[True]
    exact_refs_checked: StringSet
    unresolved_discrepancies: list[Any] = Field(..., max_length=0)
    safe_to_evict_allowed: Literal[True]
    candidate_input_tokens: conint(ge=0)
    target_min_input_tokens: conint(ge=1)
    target_max_input_tokens: conint(ge=1, le=62000)


class CompactionCommitV1(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    schema_version: SchemaVersion
    commit_id: constr(pattern=r'^COMPACTION-[A-Za-z0-9][A-Za-z0-9._-]*$')
    sequence: conint(ge=1)
    proposal_id: constr(min_length=1)
    campaign_id: constr(pattern=r'^CAMPAIGN-[A-Za-z0-9][A-Za-z0-9._-]*$')
    branch_id: constr(pattern=r'^BRANCH-[A-Za-z0-9][A-Za-z0-9._-]*$')
    base_state_version: conint(ge=0)
    previous_commit_id: (
        constr(pattern=r'^COMPACTION-[A-Za-z0-9][A-Za-z0-9._-]*$') | None
    )
    pre_checkpoint_id: constr(pattern=r'^CHECKPOINT-[A-Za-z0-9][A-Za-z0-9._-]*$')
    post_checkpoint_id: constr(pattern=r'^CHECKPOINT-[A-Za-z0-9][A-Za-z0-9._-]*$')
    proposal_sha256: constr(pattern=r'^[a-f0-9]{64}$')
    memory_index_sha256: constr(pattern=r'^[a-f0-9]{64}$')
    validation_manifest: ValidationManifest
    context_view: ContextView
    memory_records: list[dict[str, Any]] = Field(..., min_length=1)
    committed_at: AwareDatetime
    compaction_trigger: Literal['TEST_SCENE_CLOSE'] | None = None
    source_input_tokens: conint(ge=2, le=71999) | None = None
