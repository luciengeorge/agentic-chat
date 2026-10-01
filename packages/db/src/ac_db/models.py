import uuid
from datetime import date, datetime
from typing import Any

from pgvector.sqlalchemy import Vector
from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    DateTime,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    Text,
    UniqueConstraint,
    Uuid,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    type_annotation_map = {  # noqa: RUF012
        str: Text,
        dict[str, Any]: JSONB,
        datetime: DateTime(timezone=True),
    }


def tenant_fk(column: str, target: str, ondelete: str | None = None) -> ForeignKeyConstraint:
    """`(tenant_id, column)` → `target (tenant_id, id)`: a row can't point into another tenant."""
    return ForeignKeyConstraint(
        ["tenant_id", column], [f"{target}.tenant_id", f"{target}.id"], ondelete=ondelete
    )


class Tenant(Base):
    __tablename__ = "tenants"

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()")
    )
    slug: Mapped[str] = mapped_column(unique=True)
    name: Mapped[str]
    created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))


class Outbox(Base):
    __tablename__ = "outbox"
    __table_args__ = (
        Index(
            "outbox_pending_idx",
            "created_at",
            postgresql_where=text("published_at IS NULL AND failed_at IS NULL"),
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()")
    )
    tenant_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("tenants.id"))
    kind: Mapped[str]
    payload: Mapped[dict[str, Any]]
    partition_key: Mapped[str]
    created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
    published_at: Mapped[datetime | None]
    attempts: Mapped[int] = mapped_column(server_default=text("0"))
    last_error: Mapped[str | None]
    failed_at: Mapped[datetime | None]
    """Set once the relay gives up on the row (unknown kind, or out of attempts)."""


class Principal(Base):
    """A user or group mirrored from the tenant's directory."""

    __tablename__ = "principals"
    __table_args__ = (
        CheckConstraint("kind IN ('user', 'group')"),
        UniqueConstraint("tenant_id", "kind", "external_id"),
        UniqueConstraint("tenant_id", "id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()")
    )
    tenant_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("tenants.id"))
    kind: Mapped[str]
    external_id: Mapped[str]
    name: Mapped[str]
    """The username for a user, the path for a group."""
    display_name: Mapped[str]
    email: Mapped[str | None]
    enabled: Mapped[bool]
    synced_at: Mapped[datetime]


class GroupMember(Base):
    """A direct membership. The member is a user or a group."""

    __tablename__ = "group_members"
    __table_args__ = (
        tenant_fk("group_id", "principals"),
        tenant_fk("member_id", "principals"),
        Index("group_members_member_idx", "member_id"),
    )

    tenant_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("tenants.id"))
    group_id: Mapped[uuid.UUID] = mapped_column(primary_key=True)
    member_id: Mapped[uuid.UUID] = mapped_column(primary_key=True)


class GroupClosure(Base):
    """Computed from `group_members`: every ancestor group with every descendant user and group."""

    __tablename__ = "group_closure"
    __table_args__ = (
        tenant_fk("group_id", "principals"),
        tenant_fk("member_id", "principals"),
        Index("group_closure_member_idx", "member_id", "group_id"),
    )

    tenant_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("tenants.id"))
    group_id: Mapped[uuid.UUID] = mapped_column(primary_key=True)
    member_id: Mapped[uuid.UUID] = mapped_column(primary_key=True)
    depth: Mapped[int]


class Document(Base):
    __tablename__ = "documents"
    __table_args__ = (
        CheckConstraint("status IN ('pending', 'ingesting', 'ready', 'failed', 'deleted')"),
        UniqueConstraint("tenant_id", "source", "external_id"),
        UniqueConstraint("tenant_id", "id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()")
    )
    tenant_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("tenants.id"))
    source: Mapped[str]
    external_id: Mapped[str]
    title: Mapped[str]
    path: Mapped[str]
    mime_type: Mapped[str]
    version: Mapped[int]
    source_version: Mapped[str]
    content_hash: Mapped[str]
    storage_key: Mapped[str | None]
    status: Mapped[str]
    acl_version: Mapped[int] = mapped_column(BigInteger, server_default=text("0"))
    valid_from: Mapped[date | None]
    valid_to: Mapped[date | None]
    created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
    updated_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
    deleted_at: Mapped[datetime | None]


class DocumentAcl(Base):
    """The only authorisation decision point. ACL copies in the indexes only pre-filter recall."""

    __tablename__ = "document_acl"
    __table_args__ = (
        CheckConstraint("effect IN ('allow', 'deny')"),
        tenant_fk("document_id", "documents", ondelete="CASCADE"),
        tenant_fk("principal_id", "principals"),
        Index("document_acl_principal_idx", "principal_id"),
    )

    tenant_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("tenants.id"))
    document_id: Mapped[uuid.UUID] = mapped_column(primary_key=True)
    principal_id: Mapped[uuid.UUID] = mapped_column(primary_key=True)
    effect: Mapped[str]
    acl_version: Mapped[int] = mapped_column(BigInteger)


class Chunk(Base):
    __tablename__ = "chunks"
    __table_args__ = (
        UniqueConstraint("document_id", "document_version", "ordinal"),
        tenant_fk("document_id", "documents", ondelete="CASCADE"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()")
    )
    tenant_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("tenants.id"))
    document_id: Mapped[uuid.UUID]
    document_version: Mapped[int]
    ordinal: Mapped[int]
    text: Mapped[str]
    page_start: Mapped[int]
    page_end: Mapped[int]
    section: Mapped[str | None]
    token_count: Mapped[int]
    embedding: Mapped[list[float] | None] = mapped_column(Vector(1536))
    embedding_model_version: Mapped[str | None]
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())


class SyncState(Base):
    __tablename__ = "sync_state"

    tenant_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("tenants.id"), primary_key=True)
    connector: Mapped[str] = mapped_column(primary_key=True)
    scope: Mapped[str] = mapped_column(primary_key=True)
    cursor: Mapped[str | None]
    delta_token: Mapped[str | None]
    last_full_crawl_at: Mapped[datetime | None]
    last_delta_at: Mapped[datetime | None]
    updated_at: Mapped[datetime] = mapped_column(server_default=text("now()"))


class Conversation(Base):
    __tablename__ = "conversations"
    __table_args__ = (
        UniqueConstraint("tenant_id", "id"),
        tenant_fk("user_id", "principals"),
        Index("conversations_user_idx", "user_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()")
    )
    tenant_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("tenants.id"))
    user_id: Mapped[uuid.UUID]
    title: Mapped[str | None]
    created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
    updated_at: Mapped[datetime] = mapped_column(server_default=text("now()"))


class Message(Base):
    __tablename__ = "messages"
    __table_args__ = (
        CheckConstraint("role IN ('user', 'assistant', 'system', 'tool')"),
        UniqueConstraint("conversation_id", "seq"),
        UniqueConstraint("conversation_id", "idempotency_key"),
        tenant_fk("conversation_id", "conversations", ondelete="CASCADE"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()")
    )
    tenant_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("tenants.id"))
    conversation_id: Mapped[uuid.UUID]
    seq: Mapped[int]
    role: Mapped[str]
    content: Mapped[dict[str, Any]]
    idempotency_key: Mapped[str | None]
    """Client-supplied, so a retried send can't add the message twice. NULLs never collide."""
    created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))


class RetrievalAudit(Base):
    __tablename__ = "retrieval_audit"
    __table_args__ = (
        tenant_fk("user_id", "principals"),
        Index("retrieval_audit_user_idx", "user_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()")
    )
    tenant_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("tenants.id"))
    user_id: Mapped[uuid.UUID]
    query_hash: Mapped[str]
    returned_ids: Mapped[list[uuid.UUID]] = mapped_column(ARRAY(Uuid()))
    denied_ids: Mapped[list[uuid.UUID]] = mapped_column(ARRAY(Uuid()))
    acl_version: Mapped[int] = mapped_column(BigInteger)
    created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
