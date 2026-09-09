# GENERATED FILE - DO NOT EDIT. source=internal/domain-event-v1.1.schema.json schema_sha256=7c32efd392174b792a25a6607bf8f070e749f7eb732c096f27a071360a6145e3

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


class EventType(Enum):
    ITEM_ACQUIRED = 'ITEM_ACQUIRED'
    ITEM_TRANSFERRED = 'ITEM_TRANSFERRED'
    ITEM_CONSUMED = 'ITEM_CONSUMED'
    ITEM_CHARGES_CHANGED = 'ITEM_CHARGES_CHANGED'
    CURRENCY_CHANGED = 'CURRENCY_CHANGED'
    HP_CHANGED = 'HP_CHANGED'
    NONLETHAL_CHANGED = 'NONLETHAL_CHANGED'
    CONDITION_ADDED = 'CONDITION_ADDED'
    CONDITION_REMOVED = 'CONDITION_REMOVED'
    SPELL_SLOT_USED = 'SPELL_SLOT_USED'
    SPELL_SLOT_RESTORED = 'SPELL_SLOT_RESTORED'
    DAILY_USE_CHANGED = 'DAILY_USE_CHANGED'
    XP_CHANGED = 'XP_CHANGED'
    LEVEL_CHANGED = 'LEVEL_CHANGED'
    LOCATION_CHANGED = 'LOCATION_CHANGED'
    TIME_ADVANCED = 'TIME_ADVANCED'
    QUEST_UPDATED = 'QUEST_UPDATED'
    NPC_KNOWLEDGE_ADDED = 'NPC_KNOWLEDGE_ADDED'
    NPC_BELIEF_CHANGED = 'NPC_BELIEF_CHANGED'
    RELATIONSHIP_CHANGED = 'RELATIONSHIP_CHANGED'
    CANON_FACT_ADDED = 'CANON_FACT_ADDED'
    CHARACTER_DIED = 'CHARACTER_DIED'
    FACTION_CLOCK_CHANGED = 'FACTION_CLOCK_CHANGED'
    RULE_RULING_RECORDED = 'RULE_RULING_RECORDED'
    DICE_ROLLED = 'DICE_ROLLED'
    NPC_PROMOTED = 'NPC_PROMOTED'


class Target(RootModel[constr(min_length=1)]):
    root: constr(min_length=1)


class EvidenceItem(RootModel[constr(min_length=1)]):
    root: constr(min_length=1)


class SourceRef(RootModel[constr(min_length=1)]):
    root: constr(min_length=1)


class DomainEventV11(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    schema_version: Literal['1.1']
    event_id: constr(pattern=r'^EV(?:ENT)?-[A-Za-z0-9][A-Za-z0-9._-]*$')
    event_type: EventType
    campaign_id: constr(pattern=r'^CAMPAIGN-[A-Za-z0-9][A-Za-z0-9._-]*$')
    branch_id: constr(pattern=r'^BRANCH-[A-Za-z0-9][A-Za-z0-9._-]*$')
    turn_id: constr(min_length=1)
    base_state_version: conint(ge=0)
    committed_state_version: conint(ge=1)
    actor_id: constr(min_length=1)
    targets: list[Target]
    correlation_id: constr(min_length=1)
    occurred_at: AwareDatetime
    campaign_time: constr(min_length=1)
    committed: Literal[True]
    payload: dict[str, Any]
    evidence: list[EvidenceItem] = Field(..., min_length=1)
    source_refs: list[SourceRef] = Field(..., min_length=1)
