import json
import uuid
from collections.abc import Callable, Iterator
from datetime import UTC, datetime
from typing import Any

import psycopg
import pytest
from alembic import command
from sqlalchemy import Engine, create_engine, delete, func, select, text
from sqlalchemy.exc import DataError, IntegrityError
from sqlalchemy.orm import Session

from ac_db.migrate import config, upgrade
from ac_db.models import (
    Base,
    Chunk,
    Conversation,
    Document,
    DocumentAcl,
    GroupClosure,
    Message,
    Principal,
    SyncState,
    Tenant,
    acl_version_seq,
)
from ac_db.testing import temporary_database

pytestmark = pytest.mark.postgres

CONTENT_TABLES = {
    "principals",
    "group_members",
    "group_closure",
    "documents",
    "document_acl",
    "chunks",
    "sync_state",
    "conversations",
    "messages",
    "retrieval_audit",
}

TENANT_TABLES_SQL = """
    SELECT c.oid, c.relname FROM pg_class c
    WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'
      AND c.relname NOT IN ('tenants', 'alembic_version')
"""


@pytest.fixture(scope="module")
def engine(database_url: str) -> Iterator[Engine]:
    engine = create_engine(database_url)
    yield engine
    engine.dispose()


@pytest.fixture
def session(engine: Engine) -> Iterator[Session]:
    """Everything a test writes is rolled back, so tests never see each other's rows."""
    with engine.connect() as conn:
        outer = conn.begin()
        with Session(conn, join_transaction_mode="create_savepoint") as session:
            yield session
        outer.rollback()


@pytest.fixture
def kestrel(session: Session) -> uuid.UUID:
    return session.scalars(select(Tenant.id).where(Tenant.slug == "kestrel")).one()


@pytest.fixture
def harbour(session: Session) -> uuid.UUID:
    return session.scalars(select(Tenant.id).where(Tenant.slug == "harbour")).one()


def add[T: Base](session: Session, row: T) -> T:
    session.add(row)
    session.flush()
    return row


def new_principal(tenant_id: uuid.UUID, kind: str = "user") -> Principal:
    name = f"{kind}-{uuid.uuid4().hex[:8]}"
    return Principal(
        tenant_id=tenant_id,
        kind=kind,
        external_id=str(uuid.uuid4()),
        name=name,
        display_name=name,
        enabled=True,
        synced_at=datetime.now(UTC),
    )


def new_document(tenant_id: uuid.UUID, status: str = "ready") -> Document:
    return Document(
        tenant_id=tenant_id,
        source="fake-workspace",
        external_id=str(uuid.uuid4()),
        title="Q3 2026 Quarterly Report",
        path="/Finance/Reports/Q3 2026 Quarterly Report.pdf",
        mime_type="application/pdf",
        version=1,
        source_version="etag-1",
        content_hash="0" * 64,
        status=status,
    )


def new_chunk(
    document: Document,
    ordinal: int,
    embedding: list[float] | None = None,
    pages: tuple[int | None, int | None] = (1, 1),
) -> Chunk:
    return Chunk(
        tenant_id=document.tenant_id,
        document_id=document.id,
        document_version=document.version,
        ordinal=ordinal,
        text="Revenue grew 12% quarter on quarter.",
        page_start=pages[0],
        page_end=pages[1],
        token_count=8,
        embedding=embedding,
    )


def new_acl(
    document: Document, principal: Principal, effect: str = "allow", acl_version: int = 1
) -> DocumentAcl:
    return DocumentAcl(
        tenant_id=document.tenant_id,
        document_id=document.id,
        principal_id=principal.id,
        effect=effect,
        acl_version=acl_version,
    )


def new_closure(group: Principal, member: Principal, depth: int = 1) -> GroupClosure:
    return GroupClosure(
        tenant_id=group.tenant_id, group_id=group.id, member_id=member.id, depth=depth
    )


def new_conversation(user: Principal) -> Conversation:
    return Conversation(tenant_id=user.tenant_id, user_id=user.id)


def new_message(
    conversation: Conversation, seq: int, key: str | None = None, role: str = "user"
) -> Message:
    return Message(
        tenant_id=conversation.tenant_id,
        conversation_id=conversation.id,
        seq=seq,
        role=role,
        content={"text": "hello"},
        idempotency_key=key,
    )


def violation(exc: pytest.ExceptionInfo[IntegrityError]) -> tuple[str, str | None]:
    orig = exc.value.orig
    assert isinstance(orig, psycopg.Error)
    return type(orig).__name__, orig.diag.constraint_name


def count[T: Base](session: Session, model: type[T], **where: object) -> int:
    query = select(func.count()).select_from(model).filter_by(**where)
    return session.scalars(query).one()


def test_duplicate_idempotency_key_is_rejected_but_null_keys_are_not(
    session: Session, kestrel: uuid.UUID
) -> None:
    user = add(session, new_principal(kestrel))
    conversation = add(session, new_conversation(user))
    other = add(session, new_conversation(user))
    session.add_all(
        [
            new_message(conversation, 1, key="client-1"),
            new_message(conversation, 2),
            new_message(conversation, 3),
            new_message(other, 1, key="client-1"),
        ]
    )
    session.flush()

    with pytest.raises(IntegrityError) as exc, session.begin_nested():
        session.add(new_message(conversation, 4, key="client-1"))
    assert violation(exc) == ("UniqueViolation", "messages_conversation_id_idempotency_key_key")


def test_duplicate_seq_in_a_conversation_is_rejected(session: Session, kestrel: uuid.UUID) -> None:
    conversation = add(session, new_conversation(add(session, new_principal(kestrel))))
    add(session, new_message(conversation, 1))

    with pytest.raises(IntegrityError) as exc, session.begin_nested():
        session.add(new_message(conversation, 1))
    assert violation(exc) == ("UniqueViolation", "messages_conversation_id_seq_key")


def test_deleting_a_document_deletes_its_chunks_and_acl(
    session: Session, kestrel: uuid.UUID
) -> None:
    document = add(session, new_document(kestrel))
    session.add_all([new_chunk(document, 0), new_chunk(document, 1)])
    add(session, new_acl(document, add(session, new_principal(kestrel, kind="group"))))

    session.execute(delete(Document).where(Document.id == document.id))

    assert count(session, Chunk, document_id=document.id) == 0
    assert count(session, DocumentAcl, document_id=document.id) == 0


def test_deleting_a_conversation_deletes_its_messages(session: Session, kestrel: uuid.UUID) -> None:
    conversation = add(session, new_conversation(add(session, new_principal(kestrel))))
    session.add_all([new_message(conversation, 1), new_message(conversation, 2)])
    session.flush()

    session.execute(delete(Conversation).where(Conversation.id == conversation.id))

    assert count(session, Message, conversation_id=conversation.id) == 0


def test_chunk_embeddings_round_trip_at_1536_dimensions(
    session: Session, kestrel: uuid.UUID
) -> None:
    document = add(session, new_document(kestrel))
    embedding = [float(i % 10) for i in range(1536)]
    chunk = add(session, new_chunk(document, 0, embedding=embedding))

    stored = session.scalars(select(Chunk.embedding).where(Chunk.id == chunk.id)).one()
    assert stored == embedding
    with pytest.raises(DataError), session.begin_nested():
        session.add(new_chunk(document, 1, embedding=[1.0, 2.0]))


@pytest.mark.parametrize("pages", [(None, None), (1, 1), (2, 5)])
def test_a_chunk_has_both_pages_or_neither(
    session: Session, kestrel: uuid.UUID, pages: tuple[int | None, int | None]
) -> None:
    document = add(session, new_document(kestrel))
    chunk = add(session, new_chunk(document, 0, pages=pages))

    stored = session.execute(
        select(Chunk.page_start, Chunk.page_end).where(Chunk.id == chunk.id)
    ).one()
    assert tuple(stored) == pages


@pytest.mark.parametrize("pages", [(1, None), (None, 1), (3, 2)])
def test_chunk_pages_are_paired_and_in_order(
    session: Session, kestrel: uuid.UUID, pages: tuple[int | None, int | None]
) -> None:
    document = add(session, new_document(kestrel))
    with pytest.raises(IntegrityError) as exc, session.begin_nested():
        session.add(new_chunk(document, 0, pages=pages))
    assert violation(exc) == ("CheckViolation", "chunks_pages_check")


def test_acl_versions_come_from_one_sequence_across_documents(
    session: Session, kestrel: uuid.UUID
) -> None:
    group = add(session, new_principal(kestrel, kind="group"))
    first = add(session, new_document(kestrel))
    second = add(session, new_document(kestrel))
    assert (first.acl_version, second.acl_version) == (0, 0)

    for document in (first, second):
        document.acl_version = session.scalars(select(acl_version_seq.next_value())).one()
        add(session, new_acl(document, group, acl_version=document.acl_version))

    assert 0 < first.acl_version < second.acl_version
    rows = session.execute(
        select(DocumentAcl.document_id, DocumentAcl.acl_version).where(
            DocumentAcl.principal_id == group.id
        )
    ).all()
    assert dict(rows) == {first.id: first.acl_version, second.id: second.acl_version}


def test_acl_high_water_mark_is_0_then_the_latest_version(database_url: str) -> None:
    """The read `RetrievalAudit.acl_version` documents. Its own database: rollbacks keep nextval."""
    mark = text("SELECT CASE WHEN is_called THEN last_value ELSE 0 END FROM acl_version_seq")
    with temporary_database(database_url) as url:
        engine = create_engine(url)
        with engine.connect() as conn:
            assert conn.scalar(mark) == 0
            conn.scalar(select(acl_version_seq.next_value()))
            latest = conn.scalar(select(acl_version_seq.next_value()))
            assert (latest, conn.scalar(mark)) == (2, 2)
        engine.dispose()


@pytest.mark.parametrize(
    ("self_row", "depth", "constraint"),
    [(True, 1, "group_closure_no_self_check"), (False, 0, "group_closure_depth_check")],
    ids=["self-row", "depth-0"],
)
def test_group_closure_refuses_self_rows_and_depth_0(
    session: Session, kestrel: uuid.UUID, self_row: bool, depth: int, constraint: str
) -> None:
    group = add(session, new_principal(kestrel, kind="group"))
    member = group if self_row else add(session, new_principal(kestrel))
    with pytest.raises(IntegrityError) as exc, session.begin_nested():
        session.add(new_closure(group, member, depth))
    assert violation(exc) == ("CheckViolation", constraint)


def test_group_closure_member_index_carries_the_tenant(session: Session) -> None:
    """The RLS policy reads tenant_id, so lookups by member stay index-only once it's forced."""
    indexdef = session.scalars(
        text("SELECT indexdef FROM pg_indexes WHERE indexname = 'group_closure_member_idx'")
    ).one()
    assert indexdef.endswith("(member_id, group_id) INCLUDE (tenant_id)")


def test_message_content_can_be_a_list(session: Session, kestrel: uuid.UUID) -> None:
    conversation = add(session, new_conversation(add(session, new_principal(kestrel))))
    blocks: list[Any] = [{"type": "text", "text": "hello"}, {"type": "tool_use", "name": "search"}]
    message = new_message(conversation, 1)
    message.content = blocks
    add(session, message)

    stored = session.scalars(select(Message.content).where(Message.id == message.id)).one()
    assert stored == blocks


def insert_message(session: Session, conversation: Conversation, content: str) -> uuid.UUID:
    return session.scalars(
        text(
            "INSERT INTO messages (tenant_id, conversation_id, seq, role, content)"
            " VALUES (:tenant_id, :conversation_id, 1, 'user', CAST(:content AS jsonb))"
            " RETURNING id"
        ),
        {
            "tenant_id": conversation.tenant_id,
            "conversation_id": conversation.id,
            "content": content,
        },
    ).one()


@pytest.mark.parametrize("content", ['"hello"', "42", "null"])
def test_message_content_refuses_json_scalars(
    session: Session, kestrel: uuid.UUID, content: str
) -> None:
    conversation = add(session, new_conversation(add(session, new_principal(kestrel))))
    with pytest.raises(IntegrityError) as exc, session.begin_nested():
        insert_message(session, conversation, content)
    assert violation(exc) == ("CheckViolation", "messages_content_check")


def test_message_content_refuses_none(session: Session, kestrel: uuid.UUID) -> None:
    """The ORM writes None as JSON null, which NOT NULL alone lets through."""
    conversation = add(session, new_conversation(add(session, new_principal(kestrel))))
    message = Message(
        tenant_id=kestrel, conversation_id=conversation.id, seq=1, role="user", content=None
    )
    with pytest.raises(IntegrityError) as exc, session.begin_nested():
        session.add(message)
    assert violation(exc) == ("CheckViolation", "messages_content_check")


@pytest.mark.parametrize("content", ['{"text": "hello"}', "[]"])
def test_message_content_can_be_an_object_or_an_array(
    session: Session, kestrel: uuid.UUID, content: str
) -> None:
    conversation = add(session, new_conversation(add(session, new_principal(kestrel))))
    message_id = insert_message(session, conversation, content)

    stored = session.scalars(select(Message.content).where(Message.id == message_id)).one()
    assert stored == json.loads(content)


def test_updates_bump_updated_at(session: Session, kestrel: uuid.UUID) -> None:
    long_ago = datetime(2020, 1, 1, tzinfo=UTC)
    document = add(session, new_document(kestrel))
    conversation = add(session, new_conversation(add(session, new_principal(kestrel))))
    sync = add(session, SyncState(tenant_id=kestrel, connector="fake-workspace", scope="kestrel"))
    rows = [document, conversation, sync]
    for row in rows:
        row.updated_at = long_ago
    session.flush()

    document.title = "Q3 2026 Quarterly Report (final)"
    conversation.title = "Revenue questions"
    sync.cursor = "page-2"
    session.flush()

    assert [row.updated_at > long_ago for row in rows] == [True, True, True]


def test_an_unknown_tenant_is_rejected(session: Session) -> None:
    with pytest.raises(IntegrityError) as exc, session.begin_nested():
        session.add(new_principal(uuid.uuid4()))
    assert violation(exc) == ("ForeignKeyViolation", "principals_tenant_id_fkey")


def test_a_row_cannot_point_at_another_tenants_row(
    session: Session, kestrel: uuid.UUID, harbour: uuid.UUID
) -> None:
    document = add(session, new_document(kestrel))
    outsider = add(session, new_principal(harbour, kind="group"))

    with pytest.raises(IntegrityError) as exc, session.begin_nested():
        session.add(new_acl(document, outsider))
    assert violation(exc) == ("ForeignKeyViolation", "document_acl_tenant_id_principal_id_fkey")


def bad_principal_kind(session: Session, tenant_id: uuid.UUID) -> Base:
    return new_principal(tenant_id, kind="robot")


def bad_document_status(session: Session, tenant_id: uuid.UUID) -> Base:
    return new_document(tenant_id, status="archived")


def bad_acl_effect(session: Session, tenant_id: uuid.UUID) -> Base:
    document = add(session, new_document(tenant_id))
    return new_acl(document, add(session, new_principal(tenant_id)), effect="maybe")


def bad_message_role(session: Session, tenant_id: uuid.UUID) -> Base:
    conversation = add(session, new_conversation(add(session, new_principal(tenant_id))))
    return new_message(conversation, 1, role="bot")


@pytest.mark.parametrize(
    ("constraint", "build"),
    [
        ("principals_kind_check", bad_principal_kind),
        ("documents_status_check", bad_document_status),
        ("document_acl_effect_check", bad_acl_effect),
        ("messages_role_check", bad_message_role),
    ],
)
def test_check_constraints_reject_unknown_values(
    session: Session,
    kestrel: uuid.UUID,
    constraint: str,
    build: Callable[[Session, uuid.UUID], Base],
) -> None:
    row = build(session, kestrel)
    with pytest.raises(IntegrityError) as exc, session.begin_nested():
        session.add(row)
    assert violation(exc) == ("CheckViolation", constraint)


def test_every_table_has_a_not_null_tenant_fk(session: Session) -> None:
    rows = session.execute(
        text(f"""
            SELECT t.relname,
                   coalesce(a.attnotnull, false) AND EXISTS (
                       SELECT FROM pg_constraint k
                       WHERE k.conrelid = t.oid AND k.contype = 'f'
                         AND k.confrelid = 'tenants'::regclass AND k.conkey = ARRAY[a.attnum]
                   ) AS ok
            FROM ({TENANT_TABLES_SQL}) t
            LEFT JOIN pg_attribute a ON a.attrelid = t.oid AND a.attname = 'tenant_id'
        """)
    ).all()
    assert {row.relname for row in rows} >= CONTENT_TABLES
    assert [row.relname for row in rows if not row.ok] == []


def test_references_between_tenant_tables_carry_the_tenant(session: Session) -> None:
    """Every FK into a tenant table pairs tenant_id with tenant_id, so it can't cross tenants.

    FK checks bypass RLS, so the policies alone wouldn't stop such a row.
    """
    rows = session.execute(
        text("""
            SELECT k.conname, EXISTS (
                SELECT FROM unnest(k.conkey, k.confkey) AS pair (local, remote)
                JOIN pg_attribute l ON l.attrelid = k.conrelid AND l.attnum = pair.local
                JOIN pg_attribute r ON r.attrelid = k.confrelid AND r.attnum = pair.remote
                WHERE l.attname = 'tenant_id' AND r.attname = 'tenant_id'
            ) AS scoped
            FROM pg_constraint k
            WHERE k.contype = 'f' AND k.connamespace = 'public'::regnamespace
              AND k.confrelid <> 'tenants'::regclass
        """)
    ).all()
    assert rows
    assert [row.conname for row in rows if not row.scoped] == []


def test_every_tenant_table_has_rls_enabled_with_the_tenant_policy(session: Session) -> None:
    rows = session.execute(
        text(f"""
            SELECT t.relname, c.relrowsecurity, c.relforcerowsecurity,
                   array_remove(array_agg(p.policyname || ' ' || p.cmd || ' ' || p.qual
                                          || ' ' || coalesce(p.with_check, '-')), NULL) AS policies
            FROM ({TENANT_TABLES_SQL}) t
            JOIN pg_class c ON c.oid = t.oid
            LEFT JOIN pg_policies p ON p.schemaname = 'public' AND p.tablename = t.relname
            GROUP BY t.relname, c.relrowsecurity, c.relforcerowsecurity
        """)
    ).all()
    found = {r.relname: (r.relrowsecurity, r.relforcerowsecurity, r.policies) for r in rows}
    outbox_policies = found["outbox"][2]
    assert len(outbox_policies) == 1
    assert outbox_policies[0].startswith("tenant_isolation ALL ")
    assert set(found) >= CONTENT_TABLES
    assert found == dict.fromkeys(found, (True, False, outbox_policies))


def test_downgrade_to_0001_and_back(database_url: str) -> None:
    with temporary_database(database_url) as url:
        command.downgrade(config(url), "0001_init")
        assert public_tables(url) == {"alembic_version", "tenants", "outbox"}
        upgrade(url)
        assert public_tables(url) == {"alembic_version", "tenants", "outbox", *CONTENT_TABLES}


def public_tables(url: str) -> set[str]:
    engine = create_engine(url)
    with engine.connect() as conn:
        tables = conn.scalars(text("SELECT tablename FROM pg_tables WHERE schemaname = 'public'"))
        names = set(tables)
    engine.dispose()
    return names
