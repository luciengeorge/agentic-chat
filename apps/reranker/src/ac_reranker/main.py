"""ASGI entry point: `uvicorn ac_reranker.main:app`."""

from ac_core import slots

slots.install()

from ac_core.logging import configure_logging
from ac_core.settings import get_settings
from ac_core.tracing import configure_tracing
from ac_reranker.app import SERVICE, create_app
from ac_reranker.scorer import CrossEncoderScorer

configure_logging(SERVICE)
configure_tracing(SERVICE, get_settings())
app = create_app(CrossEncoderScorer)
