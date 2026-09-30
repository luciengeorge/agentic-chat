import uvicorn

uvicorn.run("ac_fake_workspace.main:app", host="0.0.0.0", port=8100, log_config=None)
