from functools import lru_cache
from pathlib import Path

from pydantic import Field

from ac_core.settings import Settings
from ac_core.slots import find_repo_root


def _default_corpus_dir() -> Path:
    return find_repo_root() / "fixtures" / "corpus" / "build"


class WorkspaceSettings(Settings):
    corpus_dir: Path = Field(default_factory=_default_corpus_dir)  # AC_CORPUS_DIR


@lru_cache
def get_workspace_settings() -> WorkspaceSettings:
    return WorkspaceSettings()
