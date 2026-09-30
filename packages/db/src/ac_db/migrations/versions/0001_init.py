"""tenants and outbox

Revision ID: 0001_init
Revises:
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0001_init"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE tenants (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            slug text NOT NULL UNIQUE,
            name text NOT NULL,
            created_at timestamptz NOT NULL DEFAULT now()
        )
    """)
    op.execute("""
        INSERT INTO tenants (slug, name) VALUES
            ('kestrel', 'Kestrel Pay'),
            ('harbour', 'Harbour Health')
    """)
    op.execute("""
        CREATE TABLE outbox (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            tenant_id uuid NOT NULL REFERENCES tenants (id),
            kind text NOT NULL,
            payload jsonb NOT NULL,
            partition_key text NOT NULL,
            created_at timestamptz NOT NULL DEFAULT now(),
            published_at timestamptz
        )
    """)
    op.execute(
        "CREATE INDEX outbox_unpublished_idx ON outbox (created_at) WHERE published_at IS NULL"
    )
    # Enabled, not forced: the table owner (the app role, for now) still bypasses it.
    # Section 09 forces it and moves the app onto a non-owner role.
    op.execute("ALTER TABLE outbox ENABLE ROW LEVEL SECURITY")
    op.execute("""
        CREATE POLICY tenant_isolation ON outbox
            USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    """)


def downgrade() -> None:
    op.execute("DROP TABLE outbox")
    op.execute("DROP TABLE tenants")
