"""Concrete local filesystem ports for the degraded Python workflow."""

from __future__ import annotations

import json
import os
import shutil
import uuid
from collections.abc import Callable, Sequence
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Protocol, cast

from .core import (
    build_checkpoint_manifest,
    canonical_json,
    replay_events,
    roll_dice,
    sha256_text,
    validate_event,
    validate_state,
    verify_checkpoint,
)
from .core.checkpoint import artifact_inventory, collect_dnd35_artifacts
from .core.contracts import validate_campaign_manifest, validate_contract
from .core.knowledge_acquisition import validate_new_knowledge_events
from .core.mechanical_action import (
    advance_mechanical_action,
    prepare_mechanical_action,
    validate_mechanical_candidate,
)
from .workflow import ContextAssessment, WorkflowInput, WorkflowPortError

JsonObject = dict[str, Any]
FaultInjector = Callable[[str], None]


class TokenCounter(Protocol):
    def count_tokens(self, value: WorkflowInput, context: JsonObject) -> int: ...


def _object(text: str, source: Path) -> JsonObject:
    value = json.loads(text)
    if not isinstance(value, dict):
        raise TypeError(f"{source} no contiene un objeto JSON")
    return cast(JsonObject, value)


def _read_object(file: Path) -> JsonObject:
    return _object(file.read_bytes().decode("utf-8"), file)


def _write_exclusive(file: Path, contents: str) -> None:
    file.parent.mkdir(parents=True, exist_ok=True)
    with file.open("x", encoding="utf-8", newline="") as stream:
        stream.write(contents)
        stream.flush()
        os.fsync(stream.fileno())


def _replace(file: Path, contents: str) -> None:
    temporary = file.with_name(f"{file.name}.{uuid.uuid4()}.tmp")
    try:
        _write_exclusive(temporary, contents)
        os.replace(temporary, file)
    finally:
        temporary.unlink(missing_ok=True)


def _safe_relative(root: Path, relative: Any) -> Path:
    if not isinstance(relative, str) or not relative:
        raise ValueError("ruta de campaña inválida")
    candidate = (root / relative).resolve()
    if not candidate.is_relative_to(root) or candidate == root:
        raise ValueError("ruta de campaña insegura")
    return candidate


class CampaignFiles:
    def __init__(self, campaign_root: Path) -> None:
        self.root = campaign_root.resolve()

    def manifest(self) -> JsonObject:
        value = _read_object(self.root / "campaign.json")
        errors = validate_campaign_manifest(value)
        if errors:
            raise WorkflowPortError("CAMPAIGN_MANIFEST_INVALID", "; ".join(errors))
        return value

    def state(self) -> JsonObject:
        manifest = self.manifest()
        directory = _safe_relative(self.root, manifest["paths"]["state"])
        files = sorted(
            file
            for file in directory.iterdir()
            if file.is_file()
            and file.name.startswith(f"{manifest['active_branch_id']}.")
            and file.name.endswith(".json")
        )
        if not files:
            raise WorkflowPortError("STATE_NOT_FOUND", "No existe estado canónico confirmado.")
        value = _read_object(files[-1])
        errors = validate_state(value)
        if errors:
            raise WorkflowPortError("STATE_INVALID", "; ".join(errors))
        if (
            value["campaign_id"] != manifest["campaign_id"]
            or value["branch_id"] != manifest["active_branch_id"]
            or value["state_version"] != manifest["state_version"]
        ):
            raise WorkflowPortError("STATE_MANIFEST_MISMATCH", "Estado y manifest no coinciden.")
        return value

    def interactive_manifest(self) -> JsonObject:
        manifest = self.manifest()
        if manifest.get("turn_profile") == "ASSISTED_ALPHA":
            raise WorkflowPortError(
                "ASSISTED_PROFILE_UNAVAILABLE",
                "Python conserva recuperación y handoff; no ejecuta el perfil asistido ni lo convierte en automático.",
            )
        return manifest

    def events(self) -> list[JsonObject]:
        manifest = self.manifest()
        directory = _safe_relative(self.root, manifest["paths"]["events"])
        file = directory / f"{manifest['active_branch_id']}.jsonl"
        if not file.exists():
            return []
        events = [_object(line, file) for line in file.read_text(encoding="utf-8").splitlines() if line]
        for event in events:
            errors = validate_event(event)
            if errors:
                raise WorkflowPortError("EVENT_LOG_INVALID", "; ".join(errors))
        return events

    def latest_checkpoint(self) -> JsonObject:
        manifest = self.manifest()
        directory = _safe_relative(self.root, manifest["paths"]["checkpoints"])
        verified: list[JsonObject] = []
        for candidate in directory.iterdir():
            if not candidate.is_dir() or not candidate.name.startswith("CHECKPOINT-"):
                continue
            try:
                loaded = verify_checkpoint(candidate)
            except ValueError:
                continue
            checkpoint = loaded["manifest"]
            if checkpoint["campaign_id"] == manifest["campaign_id"]:
                verified.append(checkpoint)
        if not verified:
            raise WorkflowPortError("CHECKPOINT_NOT_FOUND", "No existe checkpoint verificable.")
        return max(verified, key=lambda value: str(value["created_at"]))

    def update_manifest(self, **changes: Any) -> None:
        manifest = {**self.manifest(), **changes}
        errors = validate_campaign_manifest(manifest)
        if errors:
            raise WorkflowPortError("CAMPAIGN_MANIFEST_INVALID", "; ".join(errors))
        _replace(self.root / "campaign.json", canonical_json(manifest))


class FilesystemWriterLease:
    def __init__(self, campaign_root: Path) -> None:
        self._files = CampaignFiles(campaign_root)

    def verify(self, value: WorkflowInput) -> bool:
        file = self._files.root / "locks" / "writer.lock.json"
        try:
            lock = _read_object(file)
        except (OSError, UnicodeError, json.JSONDecodeError, ValueError):
            return False
        return (
            not validate_contract("internal/writer-lock.schema.json", lock)
            and lock["lock_token"] == value.writer_token
            and lock["campaign_id"] == value.campaign_id
            and lock["branch_id"] == value.branch_id
            and lock["owner_runtime"] == "python"
        )


class FilesystemContext:
    def __init__(
        self,
        campaign_root: Path,
        token_counter: TokenCounter,
        maximum_input_tokens: int,
    ) -> None:
        if maximum_input_tokens < 1:
            raise ValueError("maximum_input_tokens debe ser positivo")
        self._files = CampaignFiles(campaign_root)
        self._counter = token_counter
        self._maximum = maximum_input_tokens
        self.snapshot: JsonObject | None = None

    def assess(self, value: WorkflowInput) -> ContextAssessment:
        state = self._files.state()
        manifest = self._files.interactive_manifest()
        if (
            state["campaign_id"] != value.campaign_id
            or state["branch_id"] != value.branch_id
            or state["state_version"] != value.base_state_version
            or manifest["campaign_id"] != value.campaign_id
            or manifest["active_branch_id"] != value.branch_id
            or manifest["state_version"] != value.base_state_version
        ):
            raise WorkflowPortError("CONTEXT_STALE", "El contexto no coincide con el estado confirmado.")
        snapshot: JsonObject = {
            "schema_version": "1.0",
            "campaign_id": value.campaign_id,
            "branch_id": value.branch_id,
            "state_version": value.base_state_version,
            "canonical_state": state,
            "state_sha256": sha256_text(canonical_json(state)),
            "current_player_message": value.player_input,
            "ruleset_id": manifest["ruleset_id"],
        }
        count = self._counter.count_tokens(value, snapshot)
        if not isinstance(count, int) or isinstance(count, bool) or count < 0:
            raise WorkflowPortError("TOKEN_COUNT_INVALID", "El tokenizador devolvió un conteo inválido.")
        self.snapshot = snapshot
        return ContextAssessment(
            safe_to_continue=count <= self._maximum,
            reason=None
            if count <= self._maximum
            else f"El contexto requiere {count} tokens y el límite degradado es {self._maximum}.",
        )


class FilesystemTranscript:
    """Append-only transcript plus the interoperable TypeScript outbox format."""

    def __init__(
        self,
        campaign_root: Path,
        *,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        self._files = CampaignFiles(campaign_root)
        self._now = now or (lambda: datetime.now(timezone.utc))

    def append_player(self, turn: WorkflowInput) -> None:
        self._append(self._entry(turn, "player", turn.player_input))

    def stage_narration(
        self,
        turn: WorkflowInput,
        narration: str,
        event_ids: Sequence[str],
    ) -> tuple[Path, JsonObject]:
        if not narration:
            raise WorkflowPortError("NARRATION_MISSING", "READY no contiene narración publicable.")
        record: JsonObject = {
            "schema": "nyx.transcript_outbox.v1",
            "status": "PREPARED",
            "event_ids": list(event_ids),
            "entry": self._entry(turn, "gm", narration),
        }
        file = self._outbox_file(turn.turn_id)
        contents = canonical_json(record)
        if file.exists():
            if file.read_bytes().decode("utf-8") != contents:
                raise WorkflowPortError(
                    "TRANSCRIPT_OUTBOX_CONFLICT", "Ya existe otro outbox para el turno."
                )
        else:
            _write_exclusive(file, contents)
        return file, record

    def discard(self, file: Path) -> None:
        resolved = file.resolve()
        outbox = self._outbox_root()
        if not resolved.is_relative_to(outbox) or resolved.parent != outbox:
            raise WorkflowPortError("TRANSCRIPT_OUTBOX_PATH_INVALID", "Ruta de outbox insegura.")
        resolved.unlink(missing_ok=True)

    def mark_committed(self, file: Path, record: JsonObject) -> None:
        _replace(file, canonical_json({**record, "status": "COMMITTED"}))

    def drain(self) -> tuple[str, ...]:
        directory = self._outbox_root()
        if not directory.exists():
            return ()
        events = self._files.events()
        committed_event_ids = {str(event["event_id"]) for event in events}
        drained: list[str] = []
        for file in sorted(directory.glob("*.json")):
            try:
                record = _read_object(file)
                entry = record.get("entry")
                event_ids = record.get("event_ids")
                if (
                    record.get("schema") != "nyx.transcript_outbox.v1"
                    or record.get("status") not in {"PREPARED", "COMMITTED"}
                    or not isinstance(event_ids, list)
                    or any(not isinstance(item, str) or not item for item in event_ids)
                    or not isinstance(entry, dict)
                    or validate_contract("internal/transcript-entry.schema.json", entry)
                ):
                    raise WorkflowPortError(
                        "TRANSCRIPT_OUTBOX_CORRUPT", "El outbox de transcript es inválido."
                    )
                committed = record["status"] == "COMMITTED" or (
                    bool(event_ids) and all(item in committed_event_ids for item in event_ids)
                )
                if not committed:
                    continue
                self._append(cast(JsonObject, entry))
                file.unlink()
                drained.append(str(entry["transcript_id"]))
            except WorkflowPortError:
                raise
            except (OSError, UnicodeError, json.JSONDecodeError, KeyError, TypeError) as error:
                raise WorkflowPortError(
                    "TRANSCRIPT_OUTBOX_FAILED", "No se pudo recuperar el transcript pendiente."
                ) from error
        return tuple(drained)

    def _entry(self, turn: WorkflowInput, speaker: str, content: str) -> JsonObject:
        entry: JsonObject = {
            "schema_version": "1.0",
            "transcript_id": f"TRANSCRIPT-{sha256_text(f'{turn.turn_id}:{speaker}')[:24]}",
            "campaign_id": turn.campaign_id,
            "branch_id": turn.branch_id,
            "turn_id": turn.turn_id,
            "speaker": speaker,
            "content": content,
            "occurred_at": self._now().isoformat().replace("+00:00", "Z"),
            "source_refs": ["estrcuttura/05-nyx-despliegue-operacion-validacion.md:254-275"],
        }
        errors = validate_contract("internal/transcript-entry.schema.json", entry)
        if errors:
            raise WorkflowPortError("TRANSCRIPT_INVALID", "; ".join(errors))
        return entry

    def _outbox_root(self) -> Path:
        manifest = self._files.manifest()
        return _safe_relative(self._files.root, manifest["paths"]["transcript"]) / "outbox"

    def _outbox_file(self, turn_id: str) -> Path:
        return self._outbox_root() / f"{sha256_text(turn_id)[:32]}.json"

    def _append(self, entry: JsonObject) -> None:
        errors = validate_contract("internal/transcript-entry.schema.json", entry)
        if errors:
            raise WorkflowPortError("TRANSCRIPT_INVALID", "; ".join(errors))
        manifest = self._files.manifest()
        directory = _safe_relative(self._files.root, manifest["paths"]["transcript"])
        file = directory / f"{entry['branch_id']}.jsonl"
        file.parent.mkdir(parents=True, exist_ok=True)
        if file.exists():
            text = file.read_bytes().decode("utf-8")
            if text and not text.endswith("\n"):
                raise WorkflowPortError(
                    "TRANSCRIPT_CORRUPT", "El transcript contiene un tail parcial."
                )
            existing = [_object(line, file) for line in text.splitlines() if line]
            for item in existing:
                if validate_contract("internal/transcript-entry.schema.json", item):
                    raise WorkflowPortError(
                        "TRANSCRIPT_CORRUPT", "El transcript contiene una entrada inválida."
                    )
            matches = [item for item in existing if item.get("transcript_id") == entry["transcript_id"]]
            if matches:
                if len(matches) == 1 and canonical_json(matches[0]) == canonical_json(entry):
                    return
                raise WorkflowPortError(
                    "TRANSCRIPT_ID_CONFLICT", "transcript_id ya existe con otro contenido."
                )
        with file.open("a", encoding="utf-8", newline="") as stream:
            stream.write(canonical_json(entry))
            stream.flush()
            os.fsync(stream.fileno())


class FilesystemCheckpoint:
    def __init__(
        self,
        campaign_root: Path,
        *,
        now: Callable[[], datetime] | None = None,
        id_factory: Callable[[], str] | None = None,
    ) -> None:
        self._files = CampaignFiles(campaign_root)
        self._now = now or (lambda: datetime.now(timezone.utc))
        self._id = id_factory or (lambda: f"CHECKPOINT-DEGRADED-{uuid.uuid4()}")

    def create(self, turn: WorkflowInput, reason: str) -> str:
        state = self._files.state()
        events = self._files.events()
        manifest = self._files.manifest()
        parent = self._files.latest_checkpoint()
        checkpoint_id = self._id()
        if not checkpoint_id.startswith("CHECKPOINT-"):
            raise WorkflowPortError("CHECKPOINT_WRITE_FAILED", "checkpoint_id inválido.")
        created_at = self._now().isoformat().replace("+00:00", "Z")
        specification: JsonObject = {
            "checkpoint_id": checkpoint_id,
            "parent_checkpoint_id": parent["checkpoint_id"],
            "campaign_time": f"elapsed_minutes:{state['world'].get('elapsed_minutes', 0)}",
            "schema_fingerprints": manifest["fingerprints"]["schemas"],
            "prompt_fingerprints": manifest["fingerprints"]["prompts"],
            "model_fingerprint": manifest["fingerprints"]["model"],
            "created_at": created_at,
        }
        try:
            artifact_files = collect_dnd35_artifacts(
                self._files.root, state["campaign_id"], state["branch_id"],
                manifest["paths"]["checkpoints"],
            )
            checkpoint = build_checkpoint_manifest(
                checkpoint=specification, state=state, events=events,
                artifacts=artifact_inventory(artifact_files),
            )
        except (OSError, ValueError, KeyError, TypeError) as error:
            raise WorkflowPortError("CHECKPOINT_WRITE_FAILED", f"D&D boundary inválido: {error}") from error
        root = _safe_relative(self._files.root, manifest["paths"]["checkpoints"])
        final = root / checkpoint_id
        temporary = root / f".{checkpoint_id}.{uuid.uuid4()}.tmp"
        try:
            temporary.mkdir(parents=True, exist_ok=False)
            _write_exclusive(temporary / "state.json", canonical_json(state))
            _write_exclusive(
                temporary / "events.jsonl",
                "".join(canonical_json(event) for event in events),
            )
            current_files = collect_dnd35_artifacts(
                self._files.root, state["campaign_id"], state["branch_id"],
                manifest["paths"]["checkpoints"],
            )
            if artifact_inventory(current_files) != checkpoint["artifacts"]:
                raise ValueError("CHECKPOINT_HASH_MISMATCH: authority changed during capture")
            for name, data in artifact_files.items():
                _write_exclusive(temporary / name, data.decode("utf-8"))
            _write_exclusive(temporary / "manifest.json", canonical_json(checkpoint))
            verify_checkpoint(temporary, campaign_root=self._files.root)
            os.replace(temporary, final)
            verify_checkpoint(final, campaign_root=self._files.root)
            self._files.update_manifest(last_checkpoint_at=created_at)
            return checkpoint_id
        except (OSError, ValueError, KeyError, TypeError) as error:
            raise WorkflowPortError(
                "CHECKPOINT_WRITE_FAILED", f"No se pudo crear checkpoint: {error}"
            ) from error
        finally:
            if temporary.exists():
                shutil.rmtree(temporary, ignore_errors=True)


class FilesystemTurnPorts:
    def __init__(
        self,
        campaign_root: Path,
        writer_token: str,
        *,
        now: Callable[[], datetime] | None = None,
        fault_injector: FaultInjector | None = None,
    ) -> None:
        self._files = CampaignFiles(campaign_root)
        self._writer_token = writer_token
        self._now = now or (lambda: datetime.now(timezone.utc))
        self._fault = fault_injector
        self._pending_dice: dict[str, list[JsonObject]] = {}
        self._pending_rng: dict[str, JsonObject] = {}
        self._pending_roll_refs: dict[str, dict[str, JsonObject]] = {}
        self._mechanical_input: WorkflowInput | None = None
        self._mechanical_action: JsonObject | None = None

    def prepare(self, value: WorkflowInput) -> JsonObject | None:
        self._assert_lease(value)
        self._files.interactive_manifest()
        try:
            action = prepare_mechanical_action(self._files.state(), value.campaign_id,
                                               value.turn_id, value.base_state_version, value.player_input)
        except ValueError as error:
            raise WorkflowPortError(str(error), "La acción no tiene parámetros canónicos confirmados.") from error
        self._mechanical_input = value
        self._mechanical_action = action
        return action

    def _validate_mechanical(self, turn: WorkflowInput, candidate: JsonObject) -> None:
        if self._mechanical_input is None:
            return  # Legacy direct port harness; executable CLI always prepares through MechanicalPort.
        if turn != self._mechanical_input:
            raise WorkflowPortError("MECHANICAL_STATE_STALE", "El turno cambió tras preparar su acción.")
        try:
            rebound = prepare_mechanical_action(self._files.state(), turn.campaign_id,
                                                turn.turn_id, turn.base_state_version, turn.player_input)
            if rebound != self._mechanical_action:
                raise ValueError("MECHANICAL_STATE_STALE")
            refs = list(self._pending_roll_refs.get(turn.turn_id, {}).values())
            frame = advance_mechanical_action(rebound, refs) if rebound else None
            validate_mechanical_candidate(frame, candidate)
        except ValueError as error:
            raise WorkflowPortError(str(error), "Resolución mecánica no autorizada.") from error

    def _assert_lease(self, turn: WorkflowInput) -> None:
        if turn.writer_token != self._writer_token or not FilesystemWriterLease(
            self._files.root
        ).verify(turn):
            raise WorkflowPortError("WRITER_LEASE_INVALID", "El writer Python no está confirmado.")

    def roll(self, request: JsonObject, turn: WorkflowInput) -> JsonObject:
        self._assert_lease(turn)
        self._validate_mechanical(turn, {"resolution_status": "AWAITING_ROLL", "required_rolls": [request]})
        state = self._files.state()
        rng = self._pending_rng.get(turn.turn_id, cast(JsonObject, state["rng"]))
        expression = request.get("expression")
        roll_id = request.get("roll_id")
        if not isinstance(expression, str) or not isinstance(roll_id, str):
            raise WorkflowPortError("ROLL_REQUEST_INVALID", "La tirada requiere ID y expresión.")
        previous = self._pending_roll_refs.get(turn.turn_id, {}).get(roll_id)
        if previous is not None:
            if previous["expression"] != expression:
                raise WorkflowPortError("ROLL_ID_CONFLICT", "Una tirada existente no puede cambiar de expresión.")
            return dict(previous)
        try:
            rolled = roll_dice(rng, expression)
        except ValueError as error:
            raise WorkflowPortError("ROLL_REQUEST_INVALID", str(error)) from error
        events = self._pending_dice.setdefault(turn.turn_id, [])
        base_version = turn.base_state_version + len(events)
        now = self._now().isoformat().replace("+00:00", "Z")
        event_material = f"{turn.turn_id}:{roll_id}:{rng['roll_index']}"
        event: JsonObject = {
            "schema_version": "1.1",
            "event_id": f"EV-DICE-{sha256_text(event_material)[:24]}",
            "event_type": "DICE_ROLLED",
            "campaign_id": turn.campaign_id,
            "branch_id": turn.branch_id,
            "turn_id": turn.turn_id,
            "base_state_version": base_version,
            "committed_state_version": base_version + 1,
            "actor_id": "system.dice",
            "targets": [],
            "correlation_id": f"{turn.turn_id}-DICE-{len(events) + 1}",
            "occurred_at": now,
            "campaign_time": f"elapsed_minutes:{state['world'].get('elapsed_minutes', 0)}",
            "committed": True,
            "payload": rolled["record"],
            "evidence": [f"Deterministic roll {roll_id}"] + ([f"mechanical_action:{self._mechanical_action['profile']['action_id']}"] if self._mechanical_action else []),
            "source_refs": ["estrcuttura/02-nyx-estado-reglas.md:890-923"] + (self._mechanical_action["profile"]["source_refs"] if self._mechanical_action else []),
        }
        errors = validate_event(event)
        if errors:
            raise WorkflowPortError("ROLL_EVENT_INVALID", "; ".join(errors))
        events.append(event)
        self._pending_rng[turn.turn_id] = rolled["next_rng"]
        reference = {
            "roll_id": roll_id,
            "expression": expression,
            "result": rolled["record"]["total"],
            "rng_counter": rng["roll_index"],
        }
        self._pending_roll_refs.setdefault(turn.turn_id, {})[roll_id] = reference
        return dict(reference)

    def commit(
        self,
        turn: WorkflowInput,
        plan: JsonObject,
        resolution: JsonObject,
        worker_results: Sequence[JsonObject],
        deterministic_rolls: Sequence[JsonObject],
    ) -> int:
        del plan, worker_results, deterministic_rolls
        self._assert_lease(turn)
        if resolution["patches_to_commit"]:
            raise WorkflowPortError("PATCHES_UNSUPPORTED", "Python no confirma patches sin reducer.")
        self._validate_mechanical(turn, resolution)
        base = self._files.state()
        if base["state_version"] != turn.base_state_version:
            raise WorkflowPortError("STALE_STATE", "La versión base ya no es la última.")
        dice_events = self._pending_dice.get(turn.turn_id, [])
        proposed = resolution["events_to_commit"]
        if not all(isinstance(event, dict) for event in proposed):
            raise WorkflowPortError("INVALID_EVENT", "RESOLVE produjo un evento no estructurado.")
        events = dice_events + cast(list[JsonObject], proposed)
        # Degraded runtime has no source-bound RulesAdapter. Replay remains unchanged;
        # new adjudications require returning to the primary runtime at a confirmed boundary.
        if any(event.get("event_type") == "RULE_RULING_RECORDED" for event in events):
            raise WorkflowPortError("RULES_ADAPTER_UNAVAILABLE", "Nueva regla bloqueada: requiere la autoridad reglamentaria del runtime principal.")
        try:
            validate_new_knowledge_events(base, events, resolution["player_facing_narration"], turn.player_input)
        except ValueError as error:
            raise WorkflowPortError(str(error), "La adquisición no tiene procedencia confirmada.") from error
        for event in events:
            errors = validate_event(event)
            if errors:
                raise WorkflowPortError("INVALID_EVENT", "; ".join(errors))
        transcript = FilesystemTranscript(self._files.root, now=self._now)
        outbox_file, outbox_record = transcript.stage_narration(
            turn,
            cast(str, resolution["player_facing_narration"]),
            [cast(str, event["event_id"]) for event in events],
        )
        try:
            if not events:
                transcript.mark_committed(outbox_file, outbox_record)
                transcript.drain()
                return cast(int, base["state_version"])
            try:
                candidate = replay_events(base, events)
            except ValueError as error:
                raise WorkflowPortError("INVALID_TRANSACTION", str(error)) from error
            committed = self._commit_files(turn, base, candidate, events)
            transcript.mark_committed(outbox_file, outbox_record)
            transcript.drain()
            self._pending_dice.pop(turn.turn_id, None)
            self._pending_rng.pop(turn.turn_id, None)
            self._pending_roll_refs.pop(turn.turn_id, None)
            return committed
        except WorkflowPortError as error:
            if error.code in {"INVALID_TRANSACTION", "INVALID_EVENT"}:
                transcript.discard(outbox_file)
            raise

    def _commit_files(
        self,
        turn: WorkflowInput,
        base: JsonObject,
        candidate: JsonObject,
        events: list[JsonObject],
    ) -> int:
        transaction_id = f"TX-{sha256_text(f'{turn.campaign_id}:{turn.turn_id}:{turn.base_state_version}')[:24]}"
        transaction_root = self._files.root / "transactions"
        state_root = self._files.root / "state"
        state_text = canonical_json(candidate)
        event_text = "".join(canonical_json(event) for event in events)
        state_temp = state_root / f"{transaction_id}.state.tmp"
        event_temp = transaction_root / f"{transaction_id}.events.tmp"
        state_final = state_root / (
            f"{turn.branch_id}.{int(candidate['state_version']):012d}.json"
        )
        now = self._now().isoformat().replace("+00:00", "Z")
        journal: JsonObject = {
            "schema_version": "1.1",
            "transaction_id": transaction_id,
            "campaign_id": turn.campaign_id,
            "branch_id": turn.branch_id,
            "base_state_version": base["state_version"],
            "target_state_version": candidate["state_version"],
            "stage": "PREPARED",
            "state_temp_path": f"state/{state_temp.name}",
            "state_final_path": f"state/{state_final.name}",
            "state_sha256": sha256_text(state_text),
            "event_ids": [event["event_id"] for event in events],
            "event_batch_sha256": sha256_text(event_text),
            "created_at": now,
            "updated_at": now,
        }
        try:
            transaction_root.mkdir(parents=True, exist_ok=True)
            _write_exclusive(state_temp, state_text)
            _write_exclusive(event_temp, event_text)
            self._write_journal(journal)
            self._inject("AFTER_PREPARED")
            os.replace(state_temp, state_final)
            journal["stage"] = "STATE_RENAMED"
            journal["updated_at"] = self._now().isoformat().replace("+00:00", "Z")
            self._write_journal(journal)
            self._inject("AFTER_STATE_RENAMED")
            self._append_events(turn.branch_id, events)
            journal["stage"] = "EVENTS_APPENDED"
            journal["updated_at"] = self._now().isoformat().replace("+00:00", "Z")
            self._write_journal(journal)
            self._inject("AFTER_EVENTS_APPENDED")
            self._files.update_manifest(state_version=candidate["state_version"])
            journal["stage"] = "COMMITTED"
            journal["updated_at"] = self._now().isoformat().replace("+00:00", "Z")
            self._write_journal(journal)
            self._inject("AFTER_COMMITTED")
            self._cleanup(transaction_id, journal)
            return cast(int, candidate["state_version"])
        except WorkflowPortError:
            raise
        except Exception as error:
            raise WorkflowPortError("TRANSACTION_FAILED", str(error)) from error

    def _write_journal(self, journal: JsonObject) -> None:
        errors = validate_contract("internal/transaction-journal-v1.1.schema.json", journal)
        if errors:
            raise WorkflowPortError("JOURNAL_INVALID", "; ".join(errors))
        transaction_root = self._files.root / "transactions"
        order = {"PREPARED": 1, "STATE_RENAMED": 2, "EVENTS_APPENDED": 3, "COMMITTED": 4}
        file = transaction_root / (
            f"{journal['transaction_id']}.{order[str(journal['stage'])]:02d}-"
            f"{journal['stage']}.journal.json"
        )
        if file.exists():
            if file.read_text(encoding="utf-8") != canonical_json(journal):
                raise WorkflowPortError("JOURNAL_CONFLICT", "Journal inmutable distinto.")
            return
        _write_exclusive(file, canonical_json(journal))

    def _append_events(self, branch_id: str, events: list[JsonObject]) -> None:
        file = self._files.root / "events" / f"{branch_id}.jsonl"
        file.parent.mkdir(parents=True, exist_ok=True)
        existing = self._files.events()
        known = {event["event_id"] for event in existing}
        incoming = {event["event_id"] for event in events}
        overlap = known.intersection(incoming)
        if overlap:
            if overlap == incoming:
                return
            raise WorkflowPortError("EVENT_ID_CONFLICT", "Lote parcialmente confirmado.")
        with file.open("a", encoding="utf-8", newline="") as stream:
            stream.write("".join(canonical_json(event) for event in events))
            stream.flush()
            os.fsync(stream.fileno())

    def _inject(self, point: str) -> None:
        if self._fault is not None:
            self._fault(point)

    def _cleanup(self, transaction_id: str, journal: JsonObject) -> None:
        for relative in (
            journal["state_temp_path"],
            f"transactions/{transaction_id}.events.tmp",
        ):
            file = (self._files.root / str(relative)).resolve()
            if file.is_relative_to(self._files.root):
                file.unlink(missing_ok=True)
        for file in (self._files.root / "transactions").glob(
            f"{transaction_id}.*.journal.json"
        ):
            file.unlink()


def recover_transactions(campaign_root: Path) -> tuple[str, ...]:
    files = CampaignFiles(campaign_root)
    directory = files.root / "transactions"
    if not directory.exists():
        return ()
    stage_order = {"PREPARED": 1, "STATE_RENAMED": 2, "EVENTS_APPENDED": 3, "COMMITTED": 4}
    grouped: dict[str, list[JsonObject]] = {}
    for file in directory.glob("*.journal.json"):
        journal = _read_object(file)
        errors = validate_contract("internal/transaction-journal-v1.1.schema.json", journal)
        if errors:
            raise WorkflowPortError("JOURNAL_INVALID", "; ".join(errors))
        grouped.setdefault(str(journal["transaction_id"]), []).append(journal)
    recovered: list[str] = []
    for transaction_id, journals in grouped.items():
        journal = max(journals, key=lambda value: stage_order[str(value["stage"])])
        ports = FilesystemTurnPorts(files.root, writer_token="recovery-only")
        stage = str(journal["stage"])
        if stage == "PREPARED":
            ports._cleanup(transaction_id, journal)
            recovered.append(f"{transaction_id}:ROLLED_BACK")
            continue
        state_final = (files.root / str(journal["state_final_path"])).resolve()
        if not state_final.is_relative_to(files.root) or not state_final.exists():
            raise WorkflowPortError("RECOVERY_STATE_MISSING", transaction_id)
        if sha256_text(state_final.read_text(encoding="utf-8")) != journal["state_sha256"]:
            raise WorkflowPortError("RECOVERY_STATE_INVALID", transaction_id)
        event_temp = directory / f"{transaction_id}.events.tmp"
        if not event_temp.exists():
            raise WorkflowPortError("RECOVERY_EVENTS_MISSING", transaction_id)
        event_text = event_temp.read_text(encoding="utf-8")
        if sha256_text(event_text) != journal["event_batch_sha256"]:
            raise WorkflowPortError("RECOVERY_EVENTS_INVALID", transaction_id)
        events = [_object(line, event_temp) for line in event_text.splitlines() if line]
        ports._append_events(str(journal["branch_id"]), events)
        files.update_manifest(state_version=journal["target_state_version"])
        ports._cleanup(transaction_id, journal)
        recovered.append(f"{transaction_id}:COMPLETED")
    return tuple(recovered)
