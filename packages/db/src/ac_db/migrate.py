"""Apply every migration: `python -m ac_db.migrate`."""

from pathlib import Path

from alembic import command
from alembic.config import Config

from ac_core.settings import get_settings


def config(url: str) -> Config:
    cfg = Config()
    cfg.set_main_option("script_location", str(Path(__file__).parent / "migrations"))
    cfg.set_main_option("sqlalchemy.url", url.replace("%", "%%"))
    return cfg


def upgrade(url: str, revision: str = "head") -> None:
    command.upgrade(config(url), revision)


if __name__ == "__main__":
    upgrade(get_settings().database_url)
