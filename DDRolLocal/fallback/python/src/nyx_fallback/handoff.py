"""FallbackHandoff v1 construction and confirmed-boundary validation."""

from __future__ import annotations

import json
import os
import uuid
from pathlib import Path
from typing import Any, Literal

from .core import canonical_json, sha256_text, verify_checkpoint
from .core.checkpoint import artifact_inventory, collect_dnd35_artifacts
from .core.contracts import validate_campaign_manifest, validate_contract

RuntimeOwner = Literal["typescript", "python"]
JsonObject = dict[str, Any]


def _boundary_ready(boundary: JsonObject) -> None:
    if boundary.get("transaction_status") != "IDLE":
        raise ValueError("HANDOFF_TRANSACTION_ACTIVE")
    if boundary.get("foreign_writer_lock_present") is not False:
        raise ValueError("HANDOFF_LOCK_PRESENT")


def _contract_valid(handoff: JsonObject) -> bool:
    return not validate_contract("design/fallback-handoff.schema.json", handoff)


def build_handoff(
    boundary: JsonObject,
    source_runtime: RuntimeOwner,
    target_runtime: RuntimeOwner,
    reason: str,
) -> JsonObject:
    _boundary_ready(boundary)
    if not reason.strip():
        raise ValueError("HANDOFF_CONTRACT_INVALID: reason is empty")
    handoff: JsonObject = {
        "schema_version": "1.0",
        "campaign_id": boundary.get("campaign_id"),
        "branch_id": boundary.get("branch_id"),
        "committed_state_version": boundary.get("committed_state_version"),
        "checkpoint_id": boundary.get("checkpoint_id"),
        "event_tail_hash": boundary.get("event_tail_hash"),
        "rng_hash": boundary.get("rng_hash"),
        "source_runtime": source_runtime,
        "target_runtime": target_runtime,
        "reason": reason,
        "integrity_status": "PASS",
        "foreign_writer_lock_present": False,
    }
    if not _contract_valid(handoff):
        raise ValueError("HANDOFF_CONTRACT_INVALID")
    return handoff


def validate_handoff_for_boundary(
    handoff: JsonObject,
    boundary: JsonObject,
    expected_target: RuntimeOwner,
) -> None:
    if not _contract_valid(handoff):
        raise ValueError("HANDOFF_CONTRACT_INVALID")
    if handoff.get("target_runtime") != expected_target:
        raise ValueError("HANDOFF_TARGET_MISMATCH")
    _boundary_ready(boundary)
    for handoff_key, boundary_key in (
        ("campaign_id", "campaign_id"),
        ("branch_id", "branch_id"),
        ("committed_state_version", "committed_state_version"),
        ("checkpoint_id", "checkpoint_id"),
        ("event_tail_hash", "event_tail_hash"),
        ("rng_hash", "rng_hash"),
    ):
        if handoff.get(handoff_key) != boundary.get(boundary_key):
            raise ValueError("HANDOFF_BOUNDARY_MISMATCH")


def _json_object(text: str, source: Path) -> JsonObject:
    value = json.loads(text)
    if not isinstance(value, dict):
        raise TypeError(f"{source} must contain a JSON object")
    return value


def _safe_relative(root: Path, relative: Any) -> Path:
    if not isinstance(relative, str) or not relative:
        raise ValueError("HANDOFF_BOUNDARY_UNAVAILABLE: invalid campaign path")
    resolved_root = root.resolve()
    candidate = (resolved_root / relative).resolve()
    if not candidate.is_relative_to(resolved_root) or candidate == resolved_root:
        raise ValueError("HANDOFF_BOUNDARY_UNAVAILABLE: unsafe campaign path")
    return candidate


def _transaction_status(root: Path) -> Literal["IDLE", "ACTIVE"]:
    directory = root / "transactions"
    if not directory.exists():
        return "IDLE"
    return (
        "ACTIVE"
        if any(path.name.endswith((".tmp", ".journal.json")) for path in directory.iterdir())
        else "IDLE"
    )


def inspect_confirmed_boundary(campaign_root: Path) -> JsonObject:
    root = campaign_root.resolve()
    try:
        manifest_path = root / "campaign.json"
        manifest = _json_object(manifest_path.read_bytes().decode("utf-8"), manifest_path)
        errors = validate_campaign_manifest(manifest)
        if errors:
            raise ValueError(f"invalid campaign manifest: {'; '.join(errors)}")

        checkpoint_root = _safe_relative(root, manifest["paths"]["checkpoints"])
        matches: list[JsonObject] = []
        for directory in checkpoint_root.iterdir():
            if not directory.is_dir() or not directory.name.startswith("CHECKPOINT-"):
                continue
            try:
                loaded = verify_checkpoint(directory, campaign_root=root)
            except ValueError:
                continue
            checkpoint = loaded["manifest"]
            if (
                checkpoint.get("campaign_id") == manifest["campaign_id"]
                and checkpoint.get("branch_id") == manifest["active_branch_id"]
                and checkpoint.get("state_version") == manifest["state_version"]
            ):
                matches.append(checkpoint)
        if not matches:
            raise ValueError("matching checkpoint missing")
        checkpoint = max(matches, key=lambda item: str(item["created_at"]))

        state_root = _safe_relative(root, manifest["paths"]["state"])
        state_files = sorted(
            path
            for path in state_root.iterdir()
            if path.is_file()
            and path.name.startswith(f"{manifest['active_branch_id']}.")
            and path.name.endswith(".json")
        )
        if not state_files:
            raise ValueError("confirmed state missing")
        state_text = state_files[-1].read_bytes().decode("utf-8")
        state = _json_object(state_text, state_files[-1])
        if sha256_text(state_text) != checkpoint["state_sha256"]:
            raise ValueError("state/checkpoint hash mismatch")
        if (
            state.get("campaign_id") != manifest["campaign_id"]
            or state.get("branch_id") != manifest["active_branch_id"]
            or state.get("state_version") != manifest["state_version"]
        ):
            raise ValueError("state/manifest identity mismatch")

        event_root = _safe_relative(root, manifest["paths"]["events"])
        event_file = event_root / f"{manifest['active_branch_id']}.jsonl"
        event_text = event_file.read_bytes().decode("utf-8") if event_file.exists() else ""
        if sha256_text(event_text) != checkpoint["event_tail_hash"]:
            raise ValueError("event/checkpoint hash mismatch")
        artifacts = artifact_inventory(collect_dnd35_artifacts(
            root, manifest["campaign_id"], manifest["active_branch_id"], manifest["paths"]["checkpoints"],
        ))
        if artifacts != checkpoint.get("artifacts", []):
            raise ValueError("D&D authority/checkpoint mismatch")
        return {
            "campaign_id": checkpoint["campaign_id"],
            "branch_id": checkpoint["branch_id"],
            "committed_state_version": checkpoint["state_version"],
            "checkpoint_id": checkpoint["checkpoint_id"],
            "state_sha256": checkpoint["state_sha256"],
            "event_tail_hash": checkpoint["event_tail_hash"],
            "rng_hash": checkpoint["rng_hash"],
            "transaction_status": _transaction_status(root),
            "foreign_writer_lock_present": (root / "locks" / "writer.lock.json").exists(),
        }
    except (OSError, UnicodeError, json.JSONDecodeError, KeyError, TypeError, ValueError) as error:
        if isinstance(error, ValueError) and str(error).startswith("HANDOFF_"):
            raise
        raise ValueError(f"HANDOFF_BOUNDARY_UNAVAILABLE: {error}") from error


def _handoff_file(root: Path, handoff: JsonObject) -> Path:
    return root / "handoffs" / (
        f"{handoff['checkpoint_id']}.{handoff['source_runtime']}-to-"
        f"{handoff['target_runtime']}.json"
    )


def prepare_filesystem_handoff(
    campaign_root: Path,
    source_runtime: RuntimeOwner,
    target_runtime: RuntimeOwner,
    reason: str,
) -> JsonObject:
    root = campaign_root.resolve()
    boundary = inspect_confirmed_boundary(root)
    handoff = build_handoff(boundary, source_runtime, target_runtime, reason)
    file = _handoff_file(root, handoff)
    contents = canonical_json(handoff)
    file.parent.mkdir(parents=True, exist_ok=True)
    if file.exists():
        if file.read_bytes().decode("utf-8") == contents:
            return handoff
        raise ValueError("HANDOFF_PERSIST_FAILED: conflicting handoff exists")
    try:
        with file.open("x", encoding="utf-8", newline="") as stream:
            stream.write(contents)
            stream.flush()
            os.fsync(stream.fileno())
    except FileExistsError as error:
        raise ValueError("HANDOFF_PERSIST_FAILED: concurrent handoff exists") from error
    return handoff


def accept_filesystem_handoff(
    campaign_root: Path,
    handoff: JsonObject,
    expected_target: RuntimeOwner,
    pid: int,
    acquired_at: str,
) -> JsonObject:
    root = campaign_root.resolve()
    boundary = inspect_confirmed_boundary(root)
    validate_handoff_for_boundary(handoff, boundary, expected_target)
    persisted_file = _handoff_file(root, handoff)
    try:
        if persisted_file.read_bytes().decode("utf-8") != canonical_json(handoff):
            raise ValueError("HANDOFF_PERSIST_FAILED: durable handoff differs")
    except (OSError, UnicodeError) as error:
        raise ValueError("HANDOFF_PERSIST_FAILED: durable handoff missing") from error
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
        raise ValueError("HANDOFF_LOCK_ACQUIRE_FAILED: invalid PID")
    lock = {
        "schema_version": "1.0",
        "lock_token": str(uuid.uuid4()),
        "campaign_id": boundary["campaign_id"],
        "branch_id": boundary["branch_id"],
        "owner_runtime": expected_target,
        "pid": pid,
        "checkpoint_id": boundary["checkpoint_id"],
        "state_sha256": boundary["state_sha256"],
        "acquired_at": acquired_at,
    }
    errors = validate_contract("internal/writer-lock.schema.json", lock)
    if errors:
        raise ValueError(f"HANDOFF_LOCK_ACQUIRE_FAILED: {'; '.join(errors)}")
    lock_file = root / "locks" / "writer.lock.json"
    lock_file.parent.mkdir(parents=True, exist_ok=True)
    try:
        with lock_file.open("x", encoding="utf-8", newline="") as stream:
            stream.write(canonical_json(lock))
            stream.flush()
            os.fsync(stream.fileno())
    except FileExistsError as error:
        raise ValueError("HANDOFF_LOCK_PRESENT") from error
    return {"handoff": handoff, "lease": {"token": lock["lock_token"]}}


def release_writer(campaign_root: Path, token: str) -> None:
    lock_file = campaign_root.resolve() / "locks" / "writer.lock.json"
    try:
        lock = _json_object(lock_file.read_bytes().decode("utf-8"), lock_file)
    except (OSError, UnicodeError, json.JSONDecodeError, TypeError) as error:
        raise ValueError(f"HANDOFF_LOCK_RELEASE_FAILED: {error}") from error
    errors = validate_contract("internal/writer-lock.schema.json", lock)
    if errors:
        raise ValueError(f"HANDOFF_LOCK_RELEASE_FAILED: {'; '.join(errors)}")
    if lock.get("lock_token") != token:
        raise ValueError("HANDOFF_LOCK_RELEASE_FAILED: token mismatch")
    lock_file.unlink()
