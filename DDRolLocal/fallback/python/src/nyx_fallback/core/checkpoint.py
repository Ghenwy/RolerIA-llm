"""Read-only checkpoint integrity and manifest parity for C4."""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from typing import Any, cast

from .canonical import canonical_json, sha256_text
from .contracts import validate_checkpoint, validate_contract, validate_event
from .state import validate_state

JsonObject = dict[str, Any]


def build_checkpoint_manifest(
    *, checkpoint: JsonObject, state: JsonObject, events: list[JsonObject],
    artifacts: list[JsonObject] | None = None,
) -> JsonObject:
    state_text = canonical_json(state)
    event_text = "".join(canonical_json(event) for event in events)
    manifest: JsonObject = {
        "schema_version": "1.2",
        "artifacts": artifacts or [],
        "checkpoint_id": checkpoint["checkpoint_id"],
        "campaign_id": state["campaign_id"],
        "branch_id": state["branch_id"],
        "parent_checkpoint_id": checkpoint["parent_checkpoint_id"],
        "state_version": state["state_version"],
        "state_file": "state.json",
        "state_sha256": sha256_text(state_text),
        "event_file": "events.jsonl",
        "event_count": len(events),
        "event_tail_event_id": events[-1]["event_id"] if events else None,
        "event_tail_hash": sha256_text(event_text),
        "campaign_time": checkpoint["campaign_time"],
        "rng_hash": sha256_text(canonical_json(state["rng"])),
        "schema_fingerprints": checkpoint["schema_fingerprints"],
        "prompt_fingerprints": checkpoint["prompt_fingerprints"],
        "model_fingerprint": checkpoint["model_fingerprint"],
        "created_at": checkpoint["created_at"],
    }
    errors = validate_checkpoint(manifest)
    if errors:
        raise ValueError(f"INVALID_CHECKPOINT_MANIFEST: {'; '.join(errors)}")
    return manifest


def _json_object(text: str, source: Path) -> JsonObject:
    value = json.loads(text)
    if not isinstance(value, dict):
        raise TypeError(f"CORRUPT_DATA: {source} must contain an object")
    return cast(JsonObject, value)


def _safe_file(directory: Path, relative_path: Any) -> Path:
    if (not isinstance(relative_path, str) or not relative_path
            or "\\" in relative_path or ":" in relative_path
            or any(part in ("", ".", "..") for part in relative_path.split("/"))):
        raise ValueError("CHECKPOINT_HASH_MISMATCH: invalid relative path")
    root = directory.resolve()
    if directory.is_symlink():
        raise ValueError("CHECKPOINT_HASH_MISMATCH: symlink root")
    cursor = directory
    for part in relative_path.split("/"):
        cursor = cursor / part
        if cursor.is_symlink():
            raise ValueError("CHECKPOINT_HASH_MISMATCH: symlink artifact")
    candidate = (root / relative_path).resolve()
    if not candidate.is_relative_to(root) or candidate == root:
        raise ValueError("CHECKPOINT_HASH_MISMATCH: unsafe checkpoint path")
    return candidate


def _jsonl(data: bytes, source: Path) -> list[JsonObject]:
    text = data.decode("utf-8")
    if text and (not text.endswith("\n") or "\r" in text):
        raise ValueError("CHECKPOINT_HASH_MISMATCH: incomplete JSONL")
    return [_json_object(line, source) for line in text[:-1].split("\n")] if text else []


def artifact_inventory(files: dict[str, bytes]) -> list[JsonObject]:
    """Insertion order preserves original ancestor-to-child event segments."""
    return [{"relative_path": name, "sha256": hashlib.sha256(data).hexdigest(),
             "byte_length": len(data),
             "kind": "dnd35_events" if name.startswith("dnd35-events/") else "rule_source"}
            for name, data in files.items()]


def _verify_artifacts(manifest: JsonObject, files: dict[str, bytes]) -> list[JsonObject]:
    events: list[JsonObject] = []
    ids: set[str] = set()
    source_paths: dict[str, str] = {}
    sources: set[str] = set()
    reached_sources = False
    for artifact in manifest.get("artifacts", []):
        name = artifact["relative_path"]
        data = files[name]
        if artifact["sha256"] != hashlib.sha256(data).hexdigest() or artifact["byte_length"] != len(data):
            raise ValueError("CHECKPOINT_HASH_MISMATCH: artifact bytes changed")
        if artifact["kind"] == "rule_source":
            reached_sources = True
            continue
        if reached_sources or not re.fullmatch(r"dnd35-events/(BRANCH-[A-Za-z0-9][A-Za-z0-9._-]*)\.jsonl", name):
            raise ValueError("CHECKPOINT_HASH_MISMATCH: invalid artifact order/path")
        branch = Path(name).stem
        for event in _jsonl(data, Path(name)):
            if (validate_contract("internal/dnd35-adapter-event.schema.json", event)
                    or event["campaign_id"] != manifest["campaign_id"]
                    or event["branch_id"] != branch or event["event_id"] in ids
                    or event["base_adapter_version"] != len(events)
                    or event["committed_adapter_version"] != len(events) + 1):
                raise ValueError("CHECKPOINT_HASH_MISMATCH: invalid adapter sequence")
            ids.add(event["event_id"])
            events.append(event)
            if event["event_type"] == "RULE_SOURCE_REGISTERED":
                source = event["payload"].get("source_record")
                if (validate_contract("internal/rule-source-record.schema.json", source)
                        or source["source_id"] in sources
                        or event["payload"].get("record_id") != source["source_id"]
                        or source["source_id"] not in event["source_refs"]):
                    raise ValueError("CHECKPOINT_HASH_MISMATCH: invalid source registration")
                sources.add(source["source_id"])
                name_ref = source["local_excerpt_ref"]
                if name_ref is not None or source["content_sha256"] is not None:
                    if name_ref is None or not name_ref.startswith("rules/") or source["content_sha256"] is None:
                        raise ValueError("CHECKPOINT_HASH_MISMATCH: unsafe source path/hash")
                    if name_ref in source_paths and source_paths[name_ref] != source["content_sha256"]:
                        raise ValueError("CHECKPOINT_HASH_MISMATCH: conflicting source bytes")
                    source_paths[name_ref] = source["content_sha256"]
    actual_sources = [item["relative_path"] for item in manifest.get("artifacts", []) if item["kind"] == "rule_source"]
    if actual_sources != sorted(source_paths, key=lambda name: name.encode("utf-16-be")):
        raise ValueError("CHECKPOINT_HASH_MISMATCH: source inventory incomplete")
    if any(hashlib.sha256(files[name]).hexdigest() != digest for name, digest in source_paths.items()):
        raise ValueError("CHECKPOINT_HASH_MISMATCH: registered source changed")
    return events


def _timeline_parent(root: Path, campaign_id: str, branch_id: str) -> JsonObject | None:
    file = _safe_file(root, "timeline/entries.jsonl")
    entries = _jsonl(file.read_bytes(), file) if file.exists() else []
    ids: set[str] = set()
    parents: list[JsonObject] = []
    for entry in entries:
        if (validate_contract("internal/timeline-entry.schema.json", entry)
                or entry["campaign_id"] != campaign_id or entry["timeline_event_id"] in ids):
            raise ValueError("CHECKPOINT_HASH_MISMATCH: invalid timeline")
        ids.add(entry["timeline_event_id"])
        if entry["branch_id"] == branch_id and entry["type"] == "BRANCH_CREATED":
            parents.append(entry)
    if len(parents) > 1:
        raise ValueError("CHECKPOINT_HASH_MISMATCH: ambiguous branch ancestry")
    return parents[0] if parents else None


def _verify_snapshot_inventory(root: Path, inventory: list[JsonObject]) -> None:
    actual: set[str] = set()
    for namespace in ("rules", "dnd35-events"):
        directory = _safe_file(root, namespace)
        if not directory.exists():
            continue
        if not directory.is_dir():
            raise ValueError("CHECKPOINT_HASH_MISMATCH: invalid artifact namespace")
        for file in directory.rglob("*"):
            if file.is_symlink():
                raise ValueError("CHECKPOINT_HASH_MISMATCH: symlink artifact")
            if file.is_file():
                actual.add(file.relative_to(root).as_posix())
    if actual != {item["relative_path"] for item in inventory}:
        raise ValueError("CHECKPOINT_HASH_MISMATCH: unlisted snapshot artifact")


def collect_dnd35_artifacts(
    root: Path, campaign_id: str, branch_id: str, checkpoints_path: str = "checkpoints",
    *, seen: frozenset[str] = frozenset(),
) -> dict[str, bytes]:
    """Freeze only referenced sources and verified original event segments."""
    if branch_id in seen or not re.fullmatch(r"BRANCH-[A-Za-z0-9][A-Za-z0-9._-]*", branch_id):
        raise ValueError("CHECKPOINT_HASH_MISMATCH: cyclic/invalid ancestry")
    parent = _timeline_parent(root, campaign_id, branch_id)
    files: dict[str, bytes] = {}
    inherited_sources: dict[str, bytes] = {}
    if parent is not None:
        checkpoint_id = parent["parent_checkpoint_id"]
        if parent["parent_branch_id"] in (None, branch_id) or not isinstance(checkpoint_id, str):
            raise ValueError("CHECKPOINT_HASH_MISMATCH: invalid parent checkpoint")
        directory = _safe_file(root, f"{checkpoints_path}/{checkpoint_id}")
        loaded = verify_checkpoint(directory, campaign_root=root, seen=seen | {branch_id})
        if (loaded["manifest"]["campaign_id"] != campaign_id
                or loaded["manifest"]["checkpoint_id"] != checkpoint_id
                or loaded["manifest"]["branch_id"] != parent["parent_branch_id"]):
            raise ValueError("CHECKPOINT_HASH_MISMATCH: foreign parent checkpoint")
        if loaded["manifest"]["schema_version"] != "1.2" and collect_dnd35_artifacts(
            root, campaign_id, parent["parent_branch_id"], checkpoints_path, seen=seen | {branch_id},
        ):
            raise ValueError("CHECKPOINT_HASH_MISMATCH: legacy D&D ancestry unbound")
        for name, data in loaded["artifact_files"].items():
            (files if name.startswith("dnd35-events/") else inherited_sources)[name] = data
    own_name = f"dnd35-events/{branch_id}.jsonl"
    own_file = _safe_file(root, own_name)
    if own_file.exists() and own_file.stat().st_size:
        files[own_name] = own_file.read_bytes()
    wanted: dict[str, str] = {}
    for name, data in files.items():
        for event in _jsonl(data, Path(name)):
            if validate_contract("internal/dnd35-adapter-event.schema.json", event):
                raise ValueError("CHECKPOINT_HASH_MISMATCH: invalid adapter schema")
            if event.get("event_type") == "RULE_SOURCE_REGISTERED":
                source = event.get("payload", {}).get("source_record")
                if validate_contract("internal/rule-source-record.schema.json", source):
                    raise ValueError("CHECKPOINT_HASH_MISMATCH: invalid source registration")
                if source["local_excerpt_ref"] is not None:
                    wanted[source["local_excerpt_ref"]] = source["content_sha256"]
    for name in sorted(wanted, key=lambda name: name.encode("utf-16-be")):
        files[name] = inherited_sources[name] if name in inherited_sources else _safe_file(root, name).read_bytes()
    _verify_artifacts({"campaign_id": campaign_id, "artifacts": artifact_inventory(files)}, files)
    return files


def verify_checkpoint(
    directory: Path, *, campaign_root: Path | None = None, seen: frozenset[str] = frozenset(),
) -> JsonObject:
    root = directory.resolve()
    try:
        manifest_path = _safe_file(directory, "manifest.json")
        manifest = _json_object(manifest_path.read_bytes().decode("utf-8"), manifest_path)
        manifest_errors = validate_checkpoint(manifest)
        if manifest_errors:
            raise ValueError(f"CORRUPT_DATA: {'; '.join(manifest_errors)}")

        state_path = _safe_file(root, manifest["state_file"])
        event_path = _safe_file(root, manifest["event_file"])
        state_text = state_path.read_bytes().decode("utf-8")
        event_text = event_path.read_bytes().decode("utf-8")
        if (
            sha256_text(state_text) != manifest["state_sha256"]
            or sha256_text(event_text) != manifest["event_tail_hash"]
        ):
            raise ValueError("CHECKPOINT_HASH_MISMATCH: checkpoint bytes changed")

        state = _json_object(state_text, state_path)
        events: list[JsonObject] = []
        for line in event_text.splitlines():
            if line:
                events.append(_json_object(line, event_path))

        inconsistent = (
            state.get("campaign_id") != manifest["campaign_id"]
            or state.get("branch_id") != manifest["branch_id"]
            or state.get("state_version") != manifest["state_version"]
            or sha256_text(canonical_json(state.get("rng"))) != manifest["rng_hash"]
            or len(events) != manifest["event_count"]
            or (events[-1].get("event_id") if events else None)
            != manifest["event_tail_event_id"]
            or bool(validate_state(state))
            or any(validate_event(event) for event in events)
        )
        if inconsistent:
            raise ValueError("CHECKPOINT_HASH_MISMATCH: checkpoint content is inconsistent")
        artifact_files: dict[str, bytes] = {}
        for artifact in manifest.get("artifacts", []):
            name = artifact["relative_path"]
            if name in artifact_files or name.lower() in {key.lower() for key in artifact_files}:
                raise ValueError("CHECKPOINT_HASH_MISMATCH: duplicate artifact path")
            artifact_files[name] = _safe_file(root, name).read_bytes()
        _verify_artifacts(manifest, artifact_files)
        if manifest["schema_version"] == "1.2":
            _verify_snapshot_inventory(root, manifest["artifacts"])
            campaign = campaign_root or root.parent.parent
            branch = manifest["branch_id"]
            if branch in seen:
                raise ValueError("CHECKPOINT_HASH_MISMATCH: cyclic ancestry")
            parent = _timeline_parent(campaign, manifest["campaign_id"], branch)
            inherited: dict[str, bytes] = {}
            if parent is not None:
                if parent["parent_branch_id"] in (None, branch) or not isinstance(parent["parent_checkpoint_id"], str):
                    raise ValueError("CHECKPOINT_HASH_MISMATCH: invalid parent checkpoint")
                parent_dir = _safe_file(root.parent, parent["parent_checkpoint_id"])
                parent_loaded = verify_checkpoint(parent_dir, campaign_root=campaign, seen=seen | {branch})
                if (parent_loaded["manifest"]["campaign_id"] != manifest["campaign_id"]
                        or parent_loaded["manifest"]["checkpoint_id"] != parent["parent_checkpoint_id"]
                        or parent_loaded["manifest"]["branch_id"] != parent["parent_branch_id"]):
                    raise ValueError("CHECKPOINT_HASH_MISMATCH: foreign checkpoint ancestry")
                if parent_loaded["manifest"]["schema_version"] != "1.2":
                    checkpoints_path = root.parent.relative_to(campaign).as_posix()
                    if collect_dnd35_artifacts(campaign, manifest["campaign_id"], parent["parent_branch_id"], checkpoints_path, seen=seen | {branch}):
                        raise ValueError("CHECKPOINT_HASH_MISMATCH: legacy D&D ancestry unbound")
                inherited = parent_loaded["artifact_files"]
            expected_logs = [key for key in inherited if key.startswith("dnd35-events/")]
            own = f"dnd35-events/{branch}.jsonl"
            if own in artifact_files:
                expected_logs.append(own)
            if [key for key in artifact_files if key.startswith("dnd35-events/")] != expected_logs:
                raise ValueError("CHECKPOINT_HASH_MISMATCH: unbound ancestor segments")
            if any(artifact_files.get(name) != data for name, data in inherited.items()):
                raise ValueError("CHECKPOINT_HASH_MISMATCH: inherited artifact changed")
        return {
            "manifest": manifest,
            "state": state,
            "events": events,
            "artifact_files": artifact_files,
            "discard_kv_cache": True,
        }
    except (OSError, UnicodeError, json.JSONDecodeError, KeyError, TypeError) as error:
        raise ValueError(f"CHECKPOINT_HASH_MISMATCH: {error}") from error
