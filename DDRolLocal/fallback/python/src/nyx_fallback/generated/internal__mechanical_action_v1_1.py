# GENERATED FILE - DO NOT EDIT. source=internal/mechanical-action-v1.1.schema.json schema_sha256=7185eed1cdcab170a395eaaf68b886b75fc1c82a3a0d9ff07c8194ee8b864af3

from __future__ import annotations

from enum import Enum
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, RootModel, conint, constr


class AttackBonu(RootModel[constr(min_length=1, max_length=128)]):
    root: constr(min_length=1, max_length=128)


class ArmorClas(RootModel[constr(min_length=1, max_length=128)]):
    root: constr(min_length=1, max_length=128)


class DamageExpressionItem(RootModel[constr(min_length=1, max_length=128)]):
    root: constr(min_length=1, max_length=128)


class CriticalThresholdItem(RootModel[constr(min_length=1, max_length=128)]):
    root: constr(min_length=1, max_length=128)


class CriticalMultiplierItem(RootModel[constr(min_length=1, max_length=128)]):
    root: constr(min_length=1, max_length=128)


class CriticalImmuneItem(RootModel[constr(min_length=1, max_length=128)]):
    root: constr(min_length=1, max_length=128)


class ParameterRefs(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    attack_bonus: list[AttackBonu] = Field(..., max_length=8, min_length=1)
    armor_class: list[ArmorClas] = Field(..., max_length=8, min_length=1)
    damage_expression: list[DamageExpressionItem] = Field(
        ..., max_length=8, min_length=1
    )
    critical_threshold: list[CriticalThresholdItem] = Field(
        ..., max_length=8, min_length=1
    )
    critical_multiplier: list[CriticalMultiplierItem] = Field(
        ..., max_length=8, min_length=1
    )
    critical_immune: list[CriticalImmuneItem] = Field(..., max_length=8, min_length=1)


class SourceRef(RootModel[constr(min_length=1)]):
    root: constr(min_length=1)


class MechanicalActionProfile(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    schema_version: Literal['1.1']
    action_id: constr(pattern=r'^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')
    kind: Literal['ATTACK']
    actor_id: constr(pattern=r'^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')
    target_id: constr(pattern=r'^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')
    effect: Literal['APPLY_WEAPON_DAMAGE']
    parameter_refs: ParameterRefs
    source_refs: list[SourceRef] = Field(..., min_length=1)
    unsupported_effects: list[str] = Field(
        ...,
        description='Explicit source-gated attestation that this normal weapon action has no unsupported effects. Missing or nonempty is rejected.',
        max_length=0,
    )


class ConfirmedAttackParameters(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    attack_bonus: conint(ge=-1000000, le=1000000)
    armor_class: conint(ge=-1000000, le=1000000)
    damage_expression: constr(
        pattern=r'^[1-9][0-9]{0,2}d[1-9][0-9]{0,5}([+-][0-9]{1,6})?$'
    )
    critical_threshold: conint(ge=2, le=20)
    critical_multiplier: conint(ge=2, le=4)
    critical_immune: bool


class MechanicalRollRequest(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    roll_id: constr(min_length=1, max_length=180)
    expression: constr(pattern=r'^[1-9][0-9]*d[1-9][0-9]*([+-][0-9]+)?$')


class MechanicalRollRef(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    roll_id: constr(min_length=1, max_length=180)
    expression: str
    result: conint(ge=-9007199254740991, le=9007199254740991)
    rng_counter: conint(ge=0)


class MechanicalOutcome(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    attack_total: int
    natural_attack: conint(ge=1, le=20)
    hits: bool
    critical_confirmed: bool
    damage_total: conint(ge=0)
    effect: Literal['APPLY_WEAPON_DAMAGE']


class DeathState(Enum):
    alive = 'alive'
    disabled = 'disabled'
    dying = 'dying'
    stable = 'stable'
    dead = 'dead'
    destroyed = 'destroyed'


class TargetHealthSnapshot(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    hp_max: int
    hp_current: int
    temporary_hp: conint(ge=0)
    nonlethal_damage: conint(ge=0)
    hit_dice: list[str]
    death_state: DeathState


class MechanicalActionV11(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    schema_version: Literal['1.1']
    campaign_id: constr(pattern=r'^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')
    branch_id: constr(pattern=r'^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')
    turn_id: constr(pattern=r'^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')
    base_state_version: conint(ge=0)
    base_rng_counter: conint(ge=0)
    profile: MechanicalActionProfile
    parameters: ConfirmedAttackParameters
    rolls: list[MechanicalRollRef] = Field(..., max_length=6)
    next_roll: MechanicalRollRequest | None
    outcome: MechanicalOutcome | None
    narration: constr(max_length=1200) | None
    target_health_snapshot: TargetHealthSnapshot
