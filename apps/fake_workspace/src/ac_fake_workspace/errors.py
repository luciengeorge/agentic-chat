"""Errors in Microsoft Graph's shape: `{"error": {"code": "...", "message": "..."}}`."""

from collections.abc import Mapping

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException

CODES = {400: "invalidRequest", 401: "unauthenticated", 403: "accessDenied", 404: "itemNotFound"}


class GraphError(Exception):
    def __init__(
        self,
        status: int,
        code: str,
        message: str,
        headers: Mapping[str, str] | None = None,
        inner_code: str | None = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.headers = headers
        self.inner_code = inner_code


def bad_request(message: str) -> GraphError:
    return GraphError(400, "invalidRequest", message)


def not_found(message: str = "The resource could not be found.") -> GraphError:
    return GraphError(404, "itemNotFound", message)


def _response(error: GraphError) -> JSONResponse:
    body: dict[str, object] = {"code": error.code, "message": error.message}
    if error.inner_code is not None:
        body["innerError"] = {"code": error.inner_code}
    return JSONResponse({"error": body}, error.status, headers=error.headers)


async def _graph_error(_: Request, exc: Exception) -> JSONResponse:
    assert isinstance(exc, GraphError)
    return _response(exc)


async def _validation_error(_: Request, exc: Exception) -> JSONResponse:
    assert isinstance(exc, RequestValidationError)
    problems = "; ".join(
        f"{'.'.join(str(p) for p in error['loc'])}: {error['msg']}" for error in exc.errors()
    )
    return _response(bad_request(problems))


async def _http_error(_: Request, exc: Exception) -> JSONResponse:
    assert isinstance(exc, HTTPException)
    code = CODES.get(exc.status_code, "generalException")
    return _response(GraphError(exc.status_code, code, str(exc.detail), exc.headers))


def install_error_handlers(app: FastAPI) -> None:
    app.add_exception_handler(GraphError, _graph_error)
    app.add_exception_handler(RequestValidationError, _validation_error)
    app.add_exception_handler(HTTPException, _http_error)
