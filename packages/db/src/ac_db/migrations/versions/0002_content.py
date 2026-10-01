"""identity, content, sync, conversation and audit tables

Revision ID: 0002_content
Revises: 0001_init
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0002_content"
down_revision: str | None = "0001_init"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TABLES = (
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
)


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS vector")

    # A table that other tenant tables point at gets UNIQUE (tenant_id, id), and they reference
    # it as (tenant_id, x_id), so a row can't point into another tenant. RLS can't catch that:
    # FK checks bypass it.
    op.execute("""
        CREATE TABLE principals (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            tenant_id uuid NOT NULL REFERENCES tenants (id),
            kind text NOT NULL CHECK (kind IN ('user', 'group')),
            external_id text NOT NULL,
            name text NOT NULL,
            display_name text NOT NULL,
            email text,
            enabled boolean NOT NULL,
            synced_at timestamptz NOT NULL,
            UNIQUE (tenant_id, kind, external_id),
            UNIQUE (tenant_id, id)
        )
    """)
    op.execute("""
        CREATE TABLE group_members (
            tenant_id uuid NOT NULL REFERENCES tenants (id),
            group_id uuid NOT NULL,
            member_id uuid NOT NULL,
            PRIMARY KEY (group_id, member_id),
            FOREIGN KEY (tenant_id, group_id) REFERENCES principals (tenant_id, id),
            FOREIGN KEY (tenant_id, member_id) REFERENCES principals (tenant_id, id)
        )
    """)
    op.execute("CREATE INDEX group_members_member_idx ON group_members (member_id)")
    op.execute("""
        CREATE TABLE group_closure (
            tenant_id uuid NOT NULL REFERENCES tenants (id),
            group_id uuid NOT NULL,
            member_id uuid NOT NULL,
            depth integer NOT NULL,
            PRIMARY KEY (group_id, member_id),
            FOREIGN KEY (tenant_id, group_id) REFERENCES principals (tenant_id, id),
            FOREIGN KEY (tenant_id, member_id) REFERENCES principals (tenant_id, id)
        )
    """)
    # "Which groups is this user in?" runs on every authorised query; this answers it index-only.
    op.execute("CREATE INDEX group_closure_member_idx ON group_closure (member_id, group_id)")
    op.execute("""
        CREATE TABLE documents (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            tenant_id uuid NOT NULL REFERENCES tenants (id),
            source text NOT NULL,
            external_id text NOT NULL,
            title text NOT NULL,
            path text NOT NULL,
            mime_type text NOT NULL,
            version integer NOT NULL,
            source_version text NOT NULL,
            content_hash text NOT NULL,
            storage_key text,
            status text NOT NULL
                CHECK (status IN ('pending', 'ingesting', 'ready', 'failed', 'deleted')),
            acl_version bigint NOT NULL DEFAULT 0,
            valid_from date,
            valid_to date,
            created_at timestamptz NOT NULL DEFAULT now(),
            updated_at timestamptz NOT NULL DEFAULT now(),
            deleted_at timestamptz,
            UNIQUE (tenant_id, source, external_id),
            UNIQUE (tenant_id, id)
        )
    """)
    op.execute("""
        CREATE TABLE document_acl (
            tenant_id uuid NOT NULL REFERENCES tenants (id),
            document_id uuid NOT NULL,
            principal_id uuid NOT NULL,
            effect text NOT NULL CHECK (effect IN ('allow', 'deny')),
            acl_version bigint NOT NULL,
            PRIMARY KEY (document_id, principal_id),
            FOREIGN KEY (tenant_id, document_id)
                REFERENCES documents (tenant_id, id) ON DELETE CASCADE,
            FOREIGN KEY (tenant_id, principal_id) REFERENCES principals (tenant_id, id)
        )
    """)
    op.execute("CREATE INDEX document_acl_principal_idx ON document_acl (principal_id)")
    op.execute("""
        CREATE TABLE chunks (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            tenant_id uuid NOT NULL REFERENCES tenants (id),
            document_id uuid NOT NULL,
            document_version integer NOT NULL,
            ordinal integer NOT NULL,
            text text NOT NULL,
            page_start integer NOT NULL,
            page_end integer NOT NULL,
            section text,
            token_count integer NOT NULL,
            embedding vector(1536),
            embedding_model_version text,
            created_at timestamptz NOT NULL DEFAULT now(),
            UNIQUE (document_id, document_version, ordinal),
            FOREIGN KEY (tenant_id, document_id)
                REFERENCES documents (tenant_id, id) ON DELETE CASCADE
        )
    """)
    op.execute("""
        CREATE TABLE sync_state (
            tenant_id uuid NOT NULL REFERENCES tenants (id),
            connector text NOT NULL,
            scope text NOT NULL,
            cursor text,
            delta_token text,
            last_full_crawl_at timestamptz,
            last_delta_at timestamptz,
            updated_at timestamptz NOT NULL DEFAULT now(),
            PRIMARY KEY (tenant_id, connector, scope)
        )
    """)
    op.execute("""
        CREATE TABLE conversations (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            tenant_id uuid NOT NULL REFERENCES tenants (id),
            user_id uuid NOT NULL,
            title text,
            created_at timestamptz NOT NULL DEFAULT now(),
            updated_at timestamptz NOT NULL DEFAULT now(),
            UNIQUE (tenant_id, id),
            FOREIGN KEY (tenant_id, user_id) REFERENCES principals (tenant_id, id)
        )
    """)
    op.execute("CREATE INDEX conversations_user_idx ON conversations (user_id)")
    op.execute("""
        CREATE TABLE messages (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            tenant_id uuid NOT NULL REFERENCES tenants (id),
            conversation_id uuid NOT NULL,
            seq integer NOT NULL,
            role text NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
            content jsonb NOT NULL,
            idempotency_key text,
            created_at timestamptz NOT NULL DEFAULT now(),
            UNIQUE (conversation_id, seq),
            UNIQUE (conversation_id, idempotency_key),
            FOREIGN KEY (tenant_id, conversation_id)
                REFERENCES conversations (tenant_id, id) ON DELETE CASCADE
        )
    """)
    op.execute("""
        CREATE TABLE retrieval_audit (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            tenant_id uuid NOT NULL REFERENCES tenants (id),
            user_id uuid NOT NULL,
            query_hash text NOT NULL,
            returned_ids uuid[] NOT NULL,
            denied_ids uuid[] NOT NULL,
            acl_version bigint NOT NULL,
            created_at timestamptz NOT NULL DEFAULT now(),
            FOREIGN KEY (tenant_id, user_id) REFERENCES principals (tenant_id, id)
        )
    """)
    op.execute("CREATE INDEX retrieval_audit_user_idx ON retrieval_audit (user_id)")

    # The same policy as outbox: enabled, not forced, until section 09.
    for table in TABLES:
        op.execute(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY")
        op.execute(f"""
            CREATE POLICY tenant_isolation ON {table}
                USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
        """)


def downgrade() -> None:
    for table in reversed(TABLES):
        op.execute(f"DROP TABLE {table}")
    # The vector extension stays. In dev it predates this migration and only a superuser can
    # create it, so dropping it would leave the app role unable to upgrade again.
