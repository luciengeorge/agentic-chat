from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)


def create_direct_engine(url: str) -> AsyncEngine:
    """For workers, the relay and migrations: a session-level connection to Postgres."""
    return create_async_engine(url, pool_pre_ping=True)


def create_pooled_engine(url: str) -> AsyncEngine:
    """For the api, behind a transaction-mode pooler (PgBouncer, Neon's pooled endpoint).

    The pooler can hand each transaction a different server connection, so a
    server-side prepared statement may not exist on the next one. psycopg's
    `prepare_threshold=None` never prepares.
    """
    return create_async_engine(url, pool_pre_ping=True, connect_args={"prepare_threshold": None})


def session_factory(engine: AsyncEngine) -> async_sessionmaker[AsyncSession]:
    return async_sessionmaker(engine, expire_on_commit=False)
