"""Fail-closed sequential workflow for the degraded Python runtime."""

from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, Literal, Protocol

from .core import canonical_json, sha256_text
from .core.contracts import validate_contract
from .core.mechanical_action import advance_mechanical_action, validate_mechanical_candidate

JsonObject = dict[str, Any]


@dataclass(frozen=True)
class WorkflowInput:
    campaign_id: str
    branch_id: str
    turn_id: str
    base_state_version: int
    player_input: str
    context_refs: tuple[JsonObject, ...]
    language: str
    writer_token: str


@dataclass(frozen=True)
class ContextAssessment:
    safe_to_continue: bool
    reason: str | None


@dataclass(frozen=True)
class FallbackCapabilities:
    mode: Literal["DEGRADED_MODE"] = "DEGRADED_MODE"
    max_parallel_workers: int = 1
    automatic_priorities: tuple[str, ...] = ("P0",)
    p2_p3_automation: bool = False
    advanced_panels: bool = False
    unsafe_compaction: bool = False


FALLBACK_CAPABILITIES = FallbackCapabilities()


@dataclass(frozen=True)
class CommittedFallbackTurn:
    status: Literal["COMMITTED"]
    narration: str
    committed_state_version: int
    capabilities: FallbackCapabilities
    disabled_job_ids: tuple[str, ...]
    transitions: tuple[str, ...]


@dataclass(frozen=True)
class BlockedFallbackTurn:
    status: Literal["BLOCKED"]
    code: str
    message: str
    capabilities: FallbackCapabilities
    disabled_job_ids: tuple[str, ...]
    transitions: tuple[str, ...]
    checkpoint_id: str | None = None


FallbackTurnOutcome = CommittedFallbackTurn | BlockedFallbackTurn


class WorkflowPortError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message


class WriterLeasePort(Protocol):
    def verify(self, value: WorkflowInput) -> bool: ...


class ContextAssessmentPort(Protocol):
    def assess(self, value: WorkflowInput) -> ContextAssessment: ...


class FallbackGatewayPort(Protocol):
    def plan(self, envelope: JsonObject) -> JsonObject: ...

    def resolve(
        self,
        envelope: JsonObject,
        turn_plan: JsonObject,
        worker_results: Sequence[JsonObject],
        mechanical_action: JsonObject | None | Literal[False] = False,
    ) -> JsonObject: ...


class MechanicalPort(Protocol):
    def prepare(self, value: WorkflowInput) -> JsonObject | None: ...


class SequentialWorkerPort(Protocol):
    def execute_p0(self, value: JsonObject, turn: WorkflowInput) -> JsonObject: ...

    def execute_awaited(self, resolution: JsonObject, turn: WorkflowInput) -> JsonObject: ...


class DeterministicDicePort(Protocol):
    def roll(self, request: JsonObject, turn: WorkflowInput) -> JsonObject: ...


class StateTransactionPort(Protocol):
    def commit(
        self,
        turn: WorkflowInput,
        plan: JsonObject,
        resolution: JsonObject,
        worker_results: Sequence[JsonObject],
        deterministic_rolls: Sequence[JsonObject],
    ) -> int: ...


class CheckpointPort(Protocol):
    def create(self, turn: WorkflowInput, reason: str) -> str: ...


def _contract(relative_path: str, value: Any, code: str) -> None:
    errors = validate_contract(relative_path, value)
    if errors:
        raise WorkflowPortError(code, "; ".join(errors))


def _plan_envelope(value: WorkflowInput) -> JsonObject:
    envelope: JsonObject = {
        "schema_version": "1.0",
        "campaign_id": value.campaign_id,
        "turn_id": value.turn_id,
        "phase": "PLAN",
        "base_state_version": value.base_state_version,
        "player_input": value.player_input,
        "context_refs": list(value.context_refs),
        "worker_results": [],
        "deterministic_rolls": [],
        "language": value.language,
    }
    _contract("design/turn-envelope.schema.json", envelope, "TURN_INPUT_INVALID")
    return envelope


def _validate_plan(value: JsonObject, turn: WorkflowInput) -> None:
    _contract("sot/turn-plan.schema.json", value, "PLAN_CONTRACT_INVALID")
    if value["turn_id"] != turn.turn_id or value["base_state_version"] != turn.base_state_version:
        raise WorkflowPortError("PLAN_IDENTITY_MISMATCH", "TurnPlan no coincide con el turno confirmado.")
    safety = value["safety"]
    if not safety["player_agency_preserved"]:
        raise WorkflowPortError("PLAYER_AGENCY_VIOLATION", "TurnPlan vulnera la agencia del jugador.")
    if not safety["secret_boundaries_preserved"]:
        raise WorkflowPortError("SECRET_BOUNDARY_VIOLATION", "TurnPlan vulnera límites de secretos.")
    if value["decision"] == "ASK_CLARIFICATION" and not value["player_intent"]["ambiguities"]:
        raise WorkflowPortError(
            "PLAN_SEMANTIC_INVALID", "ASK_CLARIFICATION requiere una ambigüedad explícita."
        )
    if value["decision"] == "DELEGATE" and not value["jobs"]:
        raise WorkflowPortError("PLAN_SEMANTIC_INVALID", "DELEGATE requiere al menos un job.")


def _ordered_p0_jobs(
    plan: JsonObject, turn: WorkflowInput
) -> tuple[list[JsonObject], tuple[str, ...]]:
    jobs = plan["jobs"]
    by_id: dict[str, JsonObject] = {}
    for raw_job in jobs:
        job = raw_job
        job_id = job["job_id"]
        if job["expected_output"]["type"].upper() == "ROLL_RESULT":
            raise WorkflowPortError("PLAN_SEMANTIC_INVALID", "Dice Engine no es un worker.")
        if job_id in by_id:
            raise WorkflowPortError("PLAN_JOB_DUPLICATE", f"Job duplicado: {job_id}.")
        if job["turn_id"] != turn.turn_id or job["base_state_version"] != turn.base_state_version:
            raise WorkflowPortError(
                "PLAN_JOB_IDENTITY_MISMATCH",
                f"El job {job_id} no coincide con el turno confirmado.",
            )
        if job["priority"] != "P0" and job["blocking"]:
            raise WorkflowPortError(
                "BLOCKING_JOB_DISABLED",
                f"El fallback no puede omitir el blocking job no-P0 {job_id}.",
            )
        by_id[job_id] = job

    blocking_ids = set(plan["blocking_job_ids"])
    missing_blocking = blocking_ids.difference(by_id)
    if missing_blocking:
        raise WorkflowPortError(
            "PLAN_BLOCKING_JOB_MISSING",
            f"Blocking jobs inexistentes: {', '.join(sorted(missing_blocking))}.",
        )
    for job_id in blocking_ids:
        if by_id[job_id]["priority"] != "P0":
            raise WorkflowPortError(
                "BLOCKING_JOB_DISABLED",
                f"El fallback no puede omitir el blocking job no-P0 {job_id}.",
            )
    for job_id, job in by_id.items():
        if job["blocking"] != (job_id in blocking_ids):
            raise WorkflowPortError(
                "PLAN_BLOCKING_JOB_INCONSISTENT",
                f"El indicador blocking de {job_id} no coincide con blocking_job_ids.",
            )
        for dependency in job["dependencies"]:
            if dependency not in by_id:
                raise WorkflowPortError(
                    "PLAN_DEPENDENCY_MISSING",
                    f"El job {job_id} depende de {dependency}, que no existe.",
                )

    globally_completed: set[str] = set()
    globally_pending = list(by_id)
    while globally_pending:
        ready = next(
            (
                job_id
                for job_id in globally_pending
                if set(by_id[job_id]["dependencies"]).issubset(globally_completed)
            ),
            None,
        )
        if ready is None:
            raise WorkflowPortError("PLAN_DEPENDENCY_CYCLE", "Los jobs contienen un ciclo.")
        globally_pending.remove(ready)
        globally_completed.add(ready)

    p0_ids = [job_id for job_id, job in by_id.items() if job["priority"] == "P0"]
    p0_set = set(p0_ids)
    for job_id in p0_ids:
        job = by_id[job_id]
        if not job["blocking"] or job_id not in blocking_ids:
            raise WorkflowPortError("P0_NOT_BLOCKING", f"El job P0 {job_id} debe bloquear resolución.")
        for dependency in job["dependencies"]:
            if dependency not in p0_set:
                raise WorkflowPortError(
                    "P0_DEPENDENCY_DISABLED",
                    f"El job P0 {job_id} depende de la prioridad desactivada {dependency}.",
                )

    ordered: list[JsonObject] = []
    completed: set[str] = set()
    pending = list(p0_ids)
    while pending:
        ready = next(
            (
                job_id
                for job_id in pending
                if set(by_id[job_id]["dependencies"]).issubset(completed)
            ),
            None,
        )
        if ready is None:
            raise WorkflowPortError("P0_DEPENDENCY_CYCLE", "Los jobs P0 contienen un ciclo.")
        pending.remove(ready)
        completed.add(ready)
        ordered.append(by_id[ready])

    disabled = tuple(job_id for job_id, job in by_id.items() if job["priority"] != "P0")
    return ordered, disabled


def _worker_ref(result: JsonObject, turn: WorkflowInput, expected_job: JsonObject | None) -> JsonObject:
    _contract("sot/rpgworker-result.schema.json", result, "WORKER_RESULT_INVALID")
    if result["turn_id"] != turn.turn_id or result["base_state_version"] != turn.base_state_version:
        raise WorkflowPortError("WORKER_RESULT_STALE", "WorkerResult no coincide con el turno confirmado.")
    if result["status"] != "completed" or not result["dod"]["passed"]:
        raise WorkflowPortError("WORKER_RESULT_INCOMPLETE", "WorkerResult no está completed con DoD verde.")
    if expected_job is not None and (
        result["job_id"] != expected_job["job_id"]
        or result["worker_id"] != expected_job["worker_id"]
    ):
        raise WorkflowPortError("WORKER_RESULT_IDENTITY_MISMATCH", "WorkerResult pertenece a otro job.")
    return {
        "job_id": result["job_id"],
        "worker_id": result["worker_id"],
        "base_state_version": result["base_state_version"],
        "status": "COMPLETED",
        "sha256": sha256_text(canonical_json(result)),
    }


def _roll(request: JsonObject, result: JsonObject, seen_ids: set[str]) -> JsonObject:
    roll_id = request.get("roll_id")
    expression = request.get("expression")
    if not isinstance(roll_id, str) or not roll_id or not isinstance(expression, str) or not expression:
        raise WorkflowPortError("ROLL_REQUEST_INVALID", "La petición de tirada requiere roll_id y expression.")
    if roll_id in seen_ids:
        raise WorkflowPortError("ROLL_REQUEST_DUPLICATE", f"Tirada duplicada: {roll_id}.")
    if (
        result.get("roll_id") != roll_id
        or result.get("expression") != expression
        or not isinstance(result.get("result"), int)
        or isinstance(result.get("result"), bool)
        or not isinstance(result.get("rng_counter"), int)
        or isinstance(result.get("rng_counter"), bool)
        or result["rng_counter"] < 0
    ):
        raise WorkflowPortError("ROLL_RESULT_INVALID", "DicePort devolvió una tirada incompatible.")
    seen_ids.add(roll_id)
    return result


class FallbackWorkflow:
    def __init__(
        self,
        *,
        lease: WriterLeasePort,
        context: ContextAssessmentPort,
        gateway: FallbackGatewayPort,
        workers: SequentialWorkerPort,
        dice: DeterministicDicePort,
        state: StateTransactionPort,
        checkpoints: CheckpointPort,
        max_resolve_cycles: int,
        mechanics: MechanicalPort | None = None,
    ) -> None:
        if (
            not isinstance(max_resolve_cycles, int)
            or isinstance(max_resolve_cycles, bool)
            or max_resolve_cycles < 1
        ):
            raise ValueError("max_resolve_cycles must be a positive integer")
        self._lease = lease
        self._context = context
        self._gateway = gateway
        self._workers = workers
        self._dice = dice
        self._state = state
        self._checkpoints = checkpoints
        self._max_resolve_cycles = max_resolve_cycles
        self._mechanics = mechanics

    def run(self, value: WorkflowInput) -> FallbackTurnOutcome:
        transitions: list[str] = []
        disabled_job_ids: tuple[str, ...] = ()
        try:
            transitions.append("VERIFY_WRITER_LEASE")
            if not self._lease.verify(value):
                raise WorkflowPortError(
                    "WRITER_LEASE_INVALID", "Python no posee el writer confirmado para la campaña."
                )
            mechanical_action = self._mechanics.prepare(value) if self._mechanics else None

            transitions.append("ASSESS_CONTEXT")
            assessment = self._context.assess(value)
            if not assessment.safe_to_continue:
                reason = assessment.reason or "El contexto no puede conservarse con seguridad."
                transitions.append("CREATE_CHECKPOINT")
                checkpoint_id = self._checkpoints.create(value, reason)
                if not checkpoint_id:
                    raise WorkflowPortError("CHECKPOINT_WRITE_FAILED", "Checkpoint sin identificador.")
                return self._blocked(
                    "CONTEXT_UNSAFE_CHECKPOINTED",
                    f"Modo degradado bloqueado antes de truncar: {reason}",
                    transitions,
                    disabled_job_ids,
                    checkpoint_id,
                )

            plan_envelope = _plan_envelope(value)
            transitions.append("GM_PLAN")
            plan = self._gateway.plan(plan_envelope)
            _validate_plan(plan, value)
            if plan["decision"] == "ASK_CLARIFICATION":
                return self._blocked(
                    "PLAN_ASK_CLARIFICATION",
                    "El jugador debe aclarar su acción antes de resolver.",
                    transitions,
                    disabled_job_ids,
                )
            if plan["decision"] == "BLOCKED":
                return self._blocked(
                    "PLAN_BLOCKED", "GM PLAN bloqueó el turno.", transitions, disabled_job_ids
                )

            p0_jobs, disabled_job_ids = _ordered_p0_jobs(plan, value)
            worker_results: list[JsonObject] = []
            worker_refs: list[JsonObject] = []
            for p0_job in p0_jobs:
                transitions.append(f"P0:{p0_job['job_id']}")
                result = self._workers.execute_p0(p0_job, value)
                worker_refs.append(_worker_ref(result, value, p0_job))
                worker_results.append(result)

            deterministic_rolls: list[JsonObject] = []
            seen_roll_ids: set[str] = set()
            for cycle in range(1, self._max_resolve_cycles + 1):
                resolve_envelope: JsonObject = {
                    **plan_envelope,
                    "phase": "RESOLVE",
                    "player_input": None,
                    "worker_results": list(worker_refs),
                    "deterministic_rolls": list(deterministic_rolls),
                }
                _contract("design/turn-envelope.schema.json", resolve_envelope, "RESOLVE_INPUT_INVALID")
                transitions.append(f"GM_RESOLVE:{cycle}")
                frame = advance_mechanical_action(mechanical_action, deterministic_rolls) if mechanical_action else None
                candidate = self._gateway.resolve(resolve_envelope, plan, worker_results,
                                                  frame if self._mechanics else False)
                _contract("sot/turn-resolution.schema.json", candidate, "RESOLUTION_CONTRACT_INVALID")
                if (
                    candidate["turn_id"] != value.turn_id
                    or candidate["base_state_version"] != value.base_state_version
                ):
                    raise WorkflowPortError(
                        "RESOLUTION_IDENTITY_MISMATCH",
                        "TurnResolution no coincide con el turno confirmado.",
                    )

                status = candidate["resolution_status"]
                if self._mechanics:
                    validate_mechanical_candidate(frame, candidate)
                if status == "AWAITING_ROLL":
                    requests = candidate["required_rolls"]
                    if not requests:
                        raise WorkflowPortError(
                            "ROLL_REQUEST_MISSING", "AWAITING_ROLL no contiene tiradas."
                        )
                    for request in requests:
                        transitions.append(f"DICE:{request.get('roll_id', 'UNKNOWN')}")
                        deterministic_rolls.append(
                            _roll(request, self._dice.roll(request, value), seen_roll_ids)
                        )
                    continue

                if status == "AWAITING_WORKER":
                    transitions.append("P0:AWAITED")
                    result = self._workers.execute_awaited(candidate, value)
                    worker_refs.append(_worker_ref(result, value, None))
                    worker_results.append(result)
                    continue

                if status == "BLOCKED":
                    return self._blocked(
                        "RESOLUTION_BLOCKED",
                        "GM RESOLVE bloqueó el turno sin confirmar cambios.",
                        transitions,
                        disabled_job_ids,
                    )

                if candidate["required_rolls"]:
                    raise WorkflowPortError(
                        "READY_WITH_PENDING_ROLLS", "READY conserva tiradas sin resolver."
                    )
                # Same conservative literal-expression guard as the TypeScript orchestrator.
                explicit = re.search(r"\b[1-9][0-9]*d[1-9][0-9]*(?:[+-][0-9]+)?"
                                     r"(?=$|[ \t\r\n,.;:!?)»”\"'])(?![ \t\r\n]*[+-])",
                                     value.player_input, re.IGNORECASE | re.ASCII)
                if mechanical_action is None and explicit and not any(
                    roll["expression"] == explicit.group(0).lower() for roll in deterministic_rolls
                ):
                    raise WorkflowPortError(
                        "EXPLICIT_DICE_UNRESOLVED",
                        "La expresión explícita requiere una tirada del motor o aclaración.",
                    )
                transitions.append("STATE_TRANSACTION")
                committed_version = self._state.commit(
                    value,
                    plan,
                    candidate,
                    worker_results,
                    deterministic_rolls,
                )
                if (
                    not isinstance(committed_version, int)
                    or isinstance(committed_version, bool)
                    or committed_version < value.base_state_version
                ):
                    raise WorkflowPortError(
                        "COMMIT_RESULT_INVALID", "StatePort no confirmó una versión válida."
                    )
                transitions.append("RELEASE_NARRATION")
                return CommittedFallbackTurn(
                    status="COMMITTED",
                    narration=candidate["player_facing_narration"],
                    committed_state_version=committed_version,
                    capabilities=FALLBACK_CAPABILITIES,
                    disabled_job_ids=disabled_job_ids,
                    transitions=tuple(transitions),
                )

            raise WorkflowPortError(
                "RESOLVE_CYCLE_EXHAUSTED", "RESOLVE excedió el límite secuencial seguro."
            )
        except ValueError as error:
            return self._blocked(str(error), "La acción mecánica requiere parámetros confirmados.", transitions, disabled_job_ids)
        except WorkflowPortError as error:
            return self._blocked(
                error.code, error.message, transitions, disabled_job_ids
            )

    @staticmethod
    def _blocked(
        code: str,
        message: str,
        transitions: Sequence[str],
        disabled_job_ids: tuple[str, ...],
        checkpoint_id: str | None = None,
    ) -> BlockedFallbackTurn:
        return BlockedFallbackTurn(
            status="BLOCKED",
            code=code,
            message=message,
            capabilities=FALLBACK_CAPABILITIES,
            disabled_job_ids=disabled_job_ids,
            transitions=tuple(transitions),
            checkpoint_id=checkpoint_id,
        )
