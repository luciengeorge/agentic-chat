from alembic import context
from sqlalchemy import create_engine

from ac_core.settings import get_settings
from ac_db.models import Base

url = context.config.get_main_option("sqlalchemy.url") or get_settings().database_url
engine = create_engine(url)

try:
    with engine.connect() as connection:
        context.configure(
            connection=connection, target_metadata=Base.metadata, compare_server_default=True
        )
        with context.begin_transaction():
            context.run_migrations()
finally:
    engine.dispose()
