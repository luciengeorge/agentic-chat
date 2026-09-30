import base64
import binascii
import json
from typing import Annotated

from fastapi import Depends, FastAPI, Header, HTTPException, status
from pydantic import BaseModel, ValidationError

from ac_core.health import health_router
from ac_core.tracing import FASTAPI_TELEMETRY

SERVICE = "api"


class Claims(BaseModel):
    sub: str
    tenant: str
    iss: str


class Me(BaseModel):
    sub: str
    tenant: str
    issuer: str
    request_id: str | None


def jwt_claims(x_jwt_payload: Annotated[str | None, Header()] = None) -> Claims:
    """Claims Envoy verified and forwarded as base64url JSON. The api never sees raw tokens."""
    if x_jwt_payload is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "missing x-jwt-payload")
    try:
        raw = base64.urlsafe_b64decode(x_jwt_payload + "=" * (-len(x_jwt_payload) % 4))
        return Claims.model_validate(json.loads(raw))
    except (binascii.Error, ValueError, ValidationError) as e:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid x-jwt-payload") from e


def create_app() -> FastAPI:
    app = FastAPI(title="agentic-chat api", telemetry=FASTAPI_TELEMETRY)
    app.include_router(health_router(SERVICE))

    @app.get("/v1/me")
    def me(  # pyright: ignore[reportUnusedFunction]
        claims: Annotated[Claims, Depends(jwt_claims)],
        x_request_id: Annotated[str | None, Header()] = None,
    ) -> Me:
        return Me(sub=claims.sub, tenant=claims.tenant, issuer=claims.iss, request_id=x_request_id)

    return app
