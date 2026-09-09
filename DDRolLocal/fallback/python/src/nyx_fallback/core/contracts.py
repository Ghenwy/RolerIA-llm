"""Runtime validation against the shared JSON Schema 2020-12 contracts."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, cast

from jsonschema import Draft202012Validator, FormatChecker

JsonObject = dict[str, Any]


def product_root() -> Path:
    return Path(__file__).resolve().parents[5]


def _schema_path(relative_path: str) -> Path:
    root = (product_root() / "packages" / "contracts" / "schemas").resolve()
    candidate = (root / relative_path).resolve()
    if not candidate.is_relative_to(root) or candidate.suffix != ".json":
        raise ValueError(f"UNSAFE_SCHEMA_PATH: {relative_path}")
    return candidate


def _load_schema(relative_path: str) -> JsonObject:
    value = json.loads(_schema_path(relative_path).read_bytes().decode("utf-8"))
    if not isinstance(value, dict):
        raise TypeError(f"Schema is not an object: {relative_path}")
    return cast(JsonObject, value)


def validate_contract(relative_path: str, value: Any) -> tuple[str, ...]:
    validator = Draft202012Validator(_load_schema(relative_path), format_checker=FormatChecker())
    errors = sorted(validator.iter_errors(value), key=lambda error: list(error.absolute_path))
    return tuple(
        f"/{'/'.join(str(part) for part in error.absolute_path)} {error.message}" for error in errors
    )


def validate_state_schema(state: Any) -> tuple[str, ...]:
    errors = list(validate_contract("internal/campaign-state.schema.json", state))
    if isinstance(state, dict):
        inventories = state.get("inventories")
        if isinstance(inventories, dict):
            for inventory_id, inventory in inventories.items():
                errors.extend(
                    f"/inventories/{inventory_id}{error}"
                    for error in validate_contract("sot/inventory.schema.json", inventory)
                )
    return tuple(errors)


def validate_event(event: Any) -> tuple[str, ...]:
    return validate_contract("internal/domain-event-v1.1.schema.json", event)


def validate_campaign_manifest(manifest: Any) -> tuple[str, ...]:
    # Unknown versions still fail the selected schema; never infer an assisted profile.
    version = manifest.get("schema_version") if isinstance(manifest, dict) else None
    schema = f"campaign-manifest-v{version}" if version in ("1.1", "1.2") else "campaign-manifest"
    return validate_contract(f"design/{schema}.schema.json", manifest)


def validate_health(health: Any) -> tuple[str, ...]:
    # Reuse the literal protected facet; do not maintain a parallel health schema.
    schema = _load_schema("sot/dnd35-character-sheet.schema.json")["properties"]["health"]
    return tuple(error.message for error in Draft202012Validator(schema).iter_errors(health))


def validate_checkpoint(manifest: Any) -> tuple[str, ...]:
    version = "1.2" if isinstance(manifest, dict) and manifest.get("schema_version") == "1.2" else "1.1"
    return validate_contract(f"internal/checkpoint-manifest-v{version}.schema.json", manifest)
