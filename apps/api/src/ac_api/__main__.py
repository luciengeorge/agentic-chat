import uvicorn

uvicorn.run("ac_api.main:app", host="0.0.0.0", port=8000, log_config=None)
