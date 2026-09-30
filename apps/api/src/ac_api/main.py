"""ASGI entry point: `uvicorn ac_api.main:app`."""

from ac_core import slots

slots.install()

from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor

from ac_api.app import SERVICE, create_app
from ac_core.logging import configure_logging
from ac_core.settings import get_settings
from ac_core.tracing import configure_tracing

configure_logging(SERVICE)
configure_tracing(SERVICE, get_settings())
app = create_app()
FastAPIInstrumentor.instrument_app(app)
