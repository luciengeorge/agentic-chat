"""The corpus: document sources rendered into the blobs and manifest fake-workspace serves."""

import os
from typing import Any

from reportlab import rl_config, rl_settings


def _stock_reportlab_settings() -> None:
    """reportlab lays reportlab_settings.py, ~/.reportlab_settings and RL_* environment
    variables over its stock settings, and any of them can change the bytes it writes. This
    reruns its own start-up on the stock values with RL_* set aside. It has to run before the
    rest of reportlab is imported, since several modules copy settings at import. The font search
    paths stay as they are: every font here is built in or loaded by absolute path."""
    config: Any = rl_config  # the stubs leave out the start-up machinery used here
    saved = config._SAVED
    for name in rl_settings.__all__:
        if not name.endswith("SearchPath"):
            saved[name] = getattr(rl_settings, name)
    held = {key: os.environ.pop(key) for key in list(os.environ) if key.startswith("RL_")}
    try:
        config._startUp()
    finally:
        os.environ.update(held)


_stock_reportlab_settings()
