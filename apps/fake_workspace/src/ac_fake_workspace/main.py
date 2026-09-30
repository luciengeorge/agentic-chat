"""ASGI entry point: `uvicorn ac_fake_workspace.main:app`."""

from ac_core import slots

slots.install()

from ac_core.logging import configure_logging
from ac_core.settings import get_settings
from ac_core.tracing import configure_tracing
from ac_fake_workspace.app import SERVICE, create_app

configure_logging(SERVICE)
configure_tracing(SERVICE, get_settings())
app = create_app()
