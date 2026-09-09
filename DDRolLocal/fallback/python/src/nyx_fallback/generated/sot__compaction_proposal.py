# GENERATED FILE - DO NOT EDIT. source=sot/compaction-proposal.schema.json schema_sha256=aa53dfc0e0714b5e6a14e1f45e8817b5bd737aaa46ef21f034c7e1c67a518b97

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, conint


class SourceTurnRange(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    from_turn: conint(ge=0)
    to_turn: conint(ge=0)


class SafeToEvict(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    allowed: bool
    turn_ranges: list[dict[str, Any]]
    reason: str


class ValidationManifest(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    character_sheets_checked: list[str]
    inventories_checked: list[str]
    quests_checked: list[str]
    canon_checked: bool
    knowledge_boundaries_checked: bool
    unresolved_discrepancies: list[str]


class CompactionProposal(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    schema_version: Literal['1.0']
    proposal_id: str
    campaign_id: str
    base_state_version: int
    source_turn_range: SourceTurnRange
    preserved_exact_refs: list[str]
    scene_summary: str
    durable_memories: list[dict[str, Any]]
    npc_memory_patches: list[dict[str, Any]]
    open_threads: list[dict[str, Any]]
    retrieval_keys: list[str]
    state_patch_proposals: list[dict[str, Any]]
    safe_to_evict: SafeToEvict
    validation_manifest: ValidationManifest
