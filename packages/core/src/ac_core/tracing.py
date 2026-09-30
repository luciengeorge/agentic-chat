from collections.abc import MutableMapping
from typing import Any

from fastapi.telemetry import TelemetryConfig
from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import SERVICE_NAME, Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor

from ac_core.settings import Settings


def configure_tracing(service: str, settings: Settings) -> TracerProvider:
    """Export spans over OTLP gRPC to the collector (Grafana's, in dev)."""
    provider = TracerProvider(resource=Resource.create({SERVICE_NAME: service}))
    provider.add_span_processor(
        BatchSpanProcessor(OTLPSpanExporter(endpoint=settings.otel_exporter_otlp_endpoint))
    )
    trace.set_tracer_provider(provider)
    return provider


def _is_health_check(scope: MutableMapping[str, Any]) -> bool:
    return scope.get("path") == "/health"


# FastAPI's native telemetry records on the global providers configure_tracing sets. Its own
# OTLP auto-export would add a second, HTTP exporter aimed at our gRPC endpoint.
FASTAPI_TELEMETRY: TelemetryConfig = {"auto_configure": False, "exclude": _is_health_check}
