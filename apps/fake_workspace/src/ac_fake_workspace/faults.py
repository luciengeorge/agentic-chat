"""Injected faults: throttling, errors and latency on matching Graph requests."""

from dataclasses import dataclass
from typing import Literal, Self

from pydantic import BaseModel, Field, model_validator

from ac_fake_workspace.errors import GraphError
from ac_fake_workspace.state import Clock


class FaultSpec(BaseModel):
    site: str | None = None
    kind: Literal["throttle", "error", "latency"]
    path_prefix: str | None = None  # matched against the request path, e.g. /v1.0/sites/kestrel
    after_requests: int = Field(default=0, ge=0)  # let this many matching requests through first
    count: int | None = Field(default=None, ge=1)  # then fire this many times; None: until cleared
    retry_after_s: int | None = Field(default=None, ge=0)
    status: int = Field(default=503, ge=500, le=599)
    latency_ms: int | None = Field(default=None, ge=0)

    @model_validator(mode="after")
    def _check(self) -> Self:
        if self.kind == "latency" and self.latency_ms is None:
            raise ValueError("a latency fault needs latency_ms")
        return self


@dataclass
class _Fault:
    spec: FaultSpec
    seen: int = 0
    fired: int = 0


class Faults:
    def __init__(self, clock: Clock) -> None:
        self._clock = clock
        self._faults: list[_Fault] = []

    def add(self, spec: FaultSpec) -> None:
        self._faults.append(_Fault(spec))

    def clear(self) -> None:
        self._faults.clear()

    async def apply(self, site: str, path: str) -> None:
        """Faults are tried in the order they were added. Latency stacks; the first throttle or
        error that fires answers the request."""
        for fault in self._faults:
            spec = fault.spec
            if spec.site not in (None, site) or not path.startswith(spec.path_prefix or ""):
                continue
            fault.seen += 1
            if fault.seen <= spec.after_requests or fault.fired == spec.count:
                continue
            fault.fired += 1
            if spec.kind == "latency":
                assert spec.latency_ms is not None
                await self._clock.sleep(spec.latency_ms / 1000)
            elif spec.kind == "throttle":
                retry = {
                    "Retry-After": str(1 if spec.retry_after_s is None else spec.retry_after_s)
                }
                raise GraphError(429, "TooManyRequests", "Please retry again later.", retry)
            else:
                code = "serviceNotAvailable" if spec.status == 503 else "generalException"
                headers = None
                if spec.retry_after_s is not None:
                    headers = {"Retry-After": str(spec.retry_after_s)}
                raise GraphError(spec.status, code, "An injected fault.", headers)
