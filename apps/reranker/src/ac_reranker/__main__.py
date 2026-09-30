import uvicorn

uvicorn.run("ac_reranker.main:app", host="0.0.0.0", port=8200, log_config=None)
