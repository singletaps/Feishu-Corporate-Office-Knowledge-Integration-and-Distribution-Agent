-- ============================================================
-- 办公场景驱动的智能知识助手 — 数据库 DDL（PostgreSQL）
-- 压缩后 12 张表，单租户设计
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "vector";

-- ============================================================
-- 事项中心（4 张）
-- ============================================================

CREATE TABLE work_items (
    id                          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    title                       TEXT NOT NULL,
    item_type                   TEXT NOT NULL CHECK (item_type IN ('todo', 'decision', 'risk', 'blocker')),
    status                      TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'pending_review', 'active', 'blocked', 'done', 'closed')),
    priority                    TEXT CHECK (priority IN ('low', 'medium', 'high', 'critical')),
    owner_user_id               TEXT,
    owner_source                TEXT CHECK (owner_source IN ('manual', 'inferred', 'inherited')),
    responsible_hub_id          UUID,
    hub_assignment_source       TEXT CHECK (hub_assignment_source IN ('explicit_binding', 'chat_context', 'doc_context', 'calendar_context', 'agent_decision', 'manual_confirm', 'inherited', 'personal_fallback', 'pending')),
    due_at                      TIMESTAMPTZ,
    confidence_score            REAL,
    need_human_confirm          BOOLEAN NOT NULL DEFAULT false,
    origin_channel              TEXT CHECK (origin_channel IN ('meeting', 'minutes', 'doc', 'wiki', 'im', 'task', 'mail')),
    origin_context_id           TEXT,
    current_primary_binding_id  UUID,
    current_review_task_id      UUID,
    dedupe_key                  TEXT,
    metadata                    JSONB DEFAULT '{}'::jsonb,
    first_detected_at           TIMESTAMPTZ,
    last_detected_at            TIMESTAMPTZ,
    last_synced_at              TIMESTAMPTZ,
    last_touched_by_workflow    TEXT,
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at                  TIMESTAMPTZ
);

CREATE INDEX idx_work_items_status           ON work_items(status);
CREATE INDEX idx_work_items_owner_status     ON work_items(owner_user_id, status);
CREATE INDEX idx_work_items_responsible_hub  ON work_items(responsible_hub_id);
CREATE INDEX idx_work_items_type_status      ON work_items(item_type, status);
CREATE INDEX idx_work_items_due_at           ON work_items(due_at);
CREATE INDEX idx_work_items_confirm          ON work_items(need_human_confirm, status);
CREATE INDEX idx_work_items_origin           ON work_items(origin_channel, origin_context_id);
CREATE INDEX idx_work_items_dedupe           ON work_items(dedupe_key);
CREATE INDEX idx_work_items_metadata         ON work_items USING gin (metadata);

CREATE TABLE work_item_participants (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    work_item_id    UUID NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
    user_id         TEXT NOT NULL,
    role            TEXT NOT NULL CHECK (role IN ('owner', 'follower', 'collaborator', 'watcher')),
    source          TEXT CHECK (source IN ('manual', 'inferred', 'imported')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_participants_work_item ON work_item_participants(work_item_id);
CREATE INDEX idx_participants_user      ON work_item_participants(user_id);

CREATE TABLE task_bindings (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    work_item_id    UUID NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
    hub_id          UUID,
    projection_id   UUID,
    binding_type    TEXT NOT NULL CHECK (binding_type IN ('feishu_task', 'bitable_record')),
    external_id     TEXT NOT NULL,
    is_primary      BOOLEAN NOT NULL DEFAULT false,
    binding_role    TEXT CHECK (binding_role IN ('execution', 'tracking', 'projection')),
    sync_status     TEXT DEFAULT 'pending' CHECK (sync_status IN ('pending', 'synced', 'conflict', 'failed')),
    last_sync_at    TIMESTAMPTZ,
    last_sync_error TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_task_bindings_primary
    ON task_bindings(work_item_id, binding_type) WHERE is_primary = true;
CREATE INDEX idx_task_bindings_external ON task_bindings(external_id);
CREATE INDEX idx_task_bindings_hub      ON task_bindings(hub_id);
CREATE INDEX idx_task_bindings_projection ON task_bindings(projection_id);

CREATE TABLE work_item_audit_log (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    work_item_id        UUID NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
    change_type         TEXT NOT NULL CHECK (change_type IN ('status_change', 'field_update', 'create', 'merge', 'close')),
    field_name          TEXT,
    from_value          TEXT,
    to_value            TEXT,
    reason              TEXT,
    changed_by_type     TEXT CHECK (changed_by_type IN ('workflow', 'human', 'sync', 'policy')),
    changed_by_id       TEXT,
    execution_record_id UUID,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_work_item ON work_item_audit_log(work_item_id);
CREATE INDEX idx_audit_created   ON work_item_audit_log(created_at);

-- ============================================================
-- Hub 中枢与多表投影（4 张）
-- ============================================================

CREATE TABLE item_hubs (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    hub_type            TEXT NOT NULL CHECK (hub_type IN ('team', 'personal', 'org', 'legacy')),
    name                TEXT NOT NULL,
    feishu_base_token   TEXT NOT NULL,
    feishu_table_id     TEXT NOT NULL,
    default_chat_id     TEXT,
    owner_user_id       TEXT,
    created_by_open_id  TEXT,
    hub_status          TEXT NOT NULL DEFAULT 'active' CHECK (hub_status IN ('active', 'archived', 'dissolved')),
    dissolved_at        TIMESTAMPTZ,
    metadata            JSONB DEFAULT '{}'::jsonb,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_item_hubs_default_chat
    ON item_hubs(default_chat_id) WHERE default_chat_id IS NOT NULL AND hub_status = 'active';
CREATE INDEX idx_item_hubs_type_status ON item_hubs(hub_type, hub_status);
CREATE INDEX idx_item_hubs_owner       ON item_hubs(owner_user_id);

CREATE TABLE hub_members (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    hub_id          UUID NOT NULL REFERENCES item_hubs(id) ON DELETE CASCADE,
    user_open_id    TEXT NOT NULL,
    role            TEXT NOT NULL CHECK (role IN ('owner_admin', 'admin', 'editor', 'contributor', 'viewer', 'member', 'bot')),
    capabilities    JSONB DEFAULT '{}'::jsonb,
    joined_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    sort_key        INTEGER NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_hub_members_unique ON hub_members(hub_id, user_open_id);
CREATE INDEX idx_hub_members_user          ON hub_members(user_open_id);
CREATE INDEX idx_hub_members_owner_admin   ON hub_members(hub_id, role) WHERE role = 'owner_admin';

CREATE TABLE work_item_hub_projections (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    work_item_id        UUID NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
    hub_id              UUID NOT NULL REFERENCES item_hubs(id) ON DELETE CASCADE,
    projection_role     TEXT NOT NULL CHECK (projection_role IN ('primary', 'mirror_personal', 'mirror_team', 'mirror_owner', 'mirror_participant', 'mirror_collaboration')),
    created_reason      TEXT CHECK (created_reason IN ('explicit_binding', 'agent_decision', 'owner_personal_mirror', 'participant_personal_mirror', 'collaboration_mirror', 'inherited', 'legacy_default', 'manual_confirm')),
    created_by          TEXT,
    visibility          TEXT NOT NULL DEFAULT 'hub' CHECK (visibility IN ('hub', 'private', 'private_pending', 'restricted', 'archived_summary')),
    external_record_id  TEXT,
    bitable_record_id   TEXT,
    sync_status         TEXT DEFAULT 'pending' CHECK (sync_status IN ('pending', 'synced', 'conflict', 'failed', 'removed')),
    last_sync_at        TIMESTAMPTZ,
    last_sync_error     TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_work_item_hub_projection_unique
    ON work_item_hub_projections(work_item_id, hub_id);
CREATE INDEX idx_work_item_hub_projection_hub ON work_item_hub_projections(hub_id);
CREATE INDEX idx_work_item_hub_projection_record ON work_item_hub_projections(bitable_record_id);
CREATE UNIQUE INDEX idx_work_item_primary_projection
    ON work_item_hub_projections(work_item_id) WHERE projection_role = 'primary' AND sync_status <> 'removed';

CREATE TABLE hub_resource_bindings (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    hub_id              UUID NOT NULL REFERENCES item_hubs(id) ON DELETE CASCADE,
    resource_type       TEXT NOT NULL CHECK (resource_type IN ('chat', 'folder', 'wiki_space', 'wiki_node', 'doc', 'calendar', 'base', 'meeting')),
    resource_token      TEXT NOT NULL,
    binding_scope       TEXT NOT NULL DEFAULT 'exact' CHECK (binding_scope IN ('exact', 'children')),
    priority            INTEGER NOT NULL DEFAULT 100,
    status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suggested', 'archived')),
    created_by          TEXT,
    confirmed_by        TEXT,
    evidence_json       JSONB DEFAULT '{}'::jsonb,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_hub_resource_binding_unique
    ON hub_resource_bindings(resource_type, resource_token, hub_id, binding_scope)
    WHERE status <> 'archived';
CREATE INDEX idx_hub_resource_binding_lookup
    ON hub_resource_bindings(resource_type, resource_token, status, priority);
CREATE INDEX idx_hub_resource_binding_hub ON hub_resource_bindings(hub_id, status);

CREATE TABLE source_context_snapshots (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    origin_channel      TEXT NOT NULL CHECK (origin_channel IN ('meeting', 'minutes', 'doc', 'wiki', 'im', 'task', 'mail')),
    origin_context_id   TEXT NOT NULL,
    evidence_json       JSONB NOT NULL,
    evidence_hash       TEXT,
    created_by          TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_source_context_origin ON source_context_snapshots(origin_channel, origin_context_id, created_at);

CREATE TABLE hub_assignment_decisions (
    id                          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    work_item_id                UUID REFERENCES work_items(id) ON DELETE CASCADE,
    source_context_snapshot_id  UUID REFERENCES source_context_snapshots(id) ON DELETE SET NULL,
    primary_hub_id              UUID REFERENCES item_hubs(id) ON DELETE SET NULL,
    responsible_hub_id          UUID REFERENCES item_hubs(id) ON DELETE SET NULL,
    decision_json               JSONB NOT NULL,
    guardrail_json              JSONB NOT NULL DEFAULT '{}'::jsonb,
    confidence                  REAL,
    impact_level                TEXT CHECK (impact_level IN ('low', 'medium', 'high')),
    assignment_type             TEXT CHECK (assignment_type IN ('explicit_hub', 'chat_primary', 'doc_primary', 'calendar_primary', 'personal_primary', 'collaboration_primary', 'inherit_existing_item', 'pending_assignment')),
    router_version              TEXT NOT NULL DEFAULT 'workitem-hub-router:v1',
    auto_applied                BOOLEAN NOT NULL DEFAULT false,
    requires_human_confirmation BOOLEAN NOT NULL DEFAULT false,
    created_by                  TEXT,
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_hub_assignment_work_item ON hub_assignment_decisions(work_item_id, created_at);
CREATE INDEX idx_hub_assignment_confirmation ON hub_assignment_decisions(requires_human_confirmation, auto_applied);

CREATE TABLE hub_audit_log (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    hub_id          UUID REFERENCES item_hubs(id) ON DELETE SET NULL,
    actor_open_id   TEXT,
    action          TEXT NOT NULL,
    target_type     TEXT,
    target_id       TEXT,
    payload_json    JSONB DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_hub_audit_hub     ON hub_audit_log(hub_id, created_at);
CREATE INDEX idx_hub_audit_actor   ON hub_audit_log(actor_open_id, created_at);
CREATE INDEX idx_hub_audit_action  ON hub_audit_log(action, created_at);

-- ============================================================
-- 知识中心（3 张）
-- ============================================================

CREATE TABLE knowledge_assets (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    asset_type      TEXT NOT NULL CHECK (asset_type IN ('doc', 'docx', 'wiki', 'minutes', 'meeting_notes', 'im_message', 'task_snapshot', 'mail')),
    source_id       TEXT NOT NULL,
    title           TEXT,
    content_text    TEXT,
    content_chunk_ref TEXT,
    vector_ref      TEXT,
    owner_user_id   TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_assets_type      ON knowledge_assets(asset_type);
CREATE INDEX idx_assets_source_id ON knowledge_assets(source_id);

CREATE TABLE knowledge_artifacts (
    id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    artifact_type           TEXT NOT NULL CHECK (artifact_type IN ('pre_meeting_brief', 'meeting_summary', 'risk_report', 'weekly_insight', 'cli_hint', 'task_digest')),
    title                   TEXT,
    summary                 TEXT,
    content_payload         JSONB,
    canonical_render_format TEXT CHECK (canonical_render_format IN ('card', 'doc', 'table', 'cli_text')),
    template_version        TEXT,
    audience_type           TEXT CHECK (audience_type IN ('user', 'group', 'department', 'cli_local')),
    confidence_score        REAL,
    traceability_level      TEXT,
    status                  TEXT DEFAULT 'draft' CHECK (status IN ('draft', 'ready', 'published', 'expired', 'archived')),
    is_evaluated            BOOLEAN NOT NULL DEFAULT false,
    trigger_policy_id       UUID,
    created_by_workflow     TEXT,
    generated_at            TIMESTAMPTZ,
    expires_at              TIMESTAMPTZ,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_artifacts_type   ON knowledge_artifacts(artifact_type);
CREATE INDEX idx_artifacts_status ON knowledge_artifacts(status);

CREATE TABLE source_references (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    target_type         TEXT NOT NULL CHECK (target_type IN ('work_item', 'knowledge_artifact')),
    target_id           UUID NOT NULL,
    asset_id            UUID REFERENCES knowledge_assets(id),
    related_work_item_id UUID REFERENCES work_items(id),
    relation_type       TEXT NOT NULL CHECK (relation_type IN ('derived_from', 'evidence_for', 'related_to', 'primary_basis', 'included_item', 'risk_source', 'source', 'context')),
    excerpt             TEXT,
    confidence_score    REAL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_source_refs_target ON source_references(target_type, target_id);
CREATE INDEX idx_source_refs_asset  ON source_references(asset_id);

-- ============================================================
-- 触发与交互（3 张）
-- ============================================================

CREATE TABLE trigger_policies (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    policy_name         TEXT NOT NULL,
    policy_scope        TEXT CHECK (policy_scope IN ('B', 'D', 'A', 'C')),
    trigger_type        TEXT NOT NULL CHECK (trigger_type IN ('scheduled', 'event', 'threshold', 'manual')),
    trigger_source      TEXT CHECK (trigger_source IN ('meeting_end', 'meeting_start', 'doc_edit', 'task_change', 'mail_sync', 'cli')),
    cooldown_window     INTERVAL,
    artifact_type       TEXT,
    delivery_channel    TEXT CHECK (delivery_channel IN ('card', 'im', 'doc', 'base', 'cli')),
    target_selector     TEXT,
    review_requirement  TEXT DEFAULT 'none' CHECK (review_requirement IN ('none', 'high_risk_only', 'always')),
    enabled             BOOLEAN NOT NULL DEFAULT true,
    last_triggered_at   TIMESTAMPTZ,
    success_count       INTEGER NOT NULL DEFAULT 0,
    failure_count       INTEGER NOT NULL DEFAULT 0,
    acceptance_rate     REAL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE human_review_tasks (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    target_type         TEXT NOT NULL CHECK (target_type IN ('work_item', 'knowledge_artifact')),
    target_id           UUID NOT NULL,
    review_reason       TEXT,
    review_status       TEXT NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending', 'approved', 'rejected', 'revised')),
    assigned_reviewer   TEXT,
    reviewed_at         TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_review_status ON human_review_tasks(review_status);
CREATE INDEX idx_review_target ON human_review_tasks(target_type, target_id);

CREATE TABLE push_records (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    artifact_id         UUID REFERENCES knowledge_artifacts(id),
    channel_type        TEXT NOT NULL CHECK (channel_type IN ('card', 'im', 'doc', 'base', 'cli')),
    target_type         TEXT CHECK (target_type IN ('user', 'group', 'department', 'cli_local')),
    target_id           TEXT,
    render_version      TEXT,
    rendered_payload    JSONB,
    external_message_id TEXT,
    delivery_status     TEXT DEFAULT 'pending' CHECK (delivery_status IN ('pending', 'sent', 'failed', 'acknowledged')),
    clicked             BOOLEAN NOT NULL DEFAULT false,
    acknowledged_at     TIMESTAMPTZ,
    sent_at             TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_push_artifact ON push_records(artifact_id);
CREATE INDEX idx_push_status   ON push_records(delivery_status);

-- ============================================================
-- 过程与评测（2 张）
-- ============================================================

CREATE TABLE execution_records (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    workflow_name       TEXT NOT NULL,
    trigger_type        TEXT,
    trigger_context_id  TEXT,
    status              TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'succeeded', 'failed', 'compensating')),
    started_at          TIMESTAMPTZ,
    finished_at         TIMESTAMPTZ,
    error_code          TEXT,
    error_message       TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_exec_status   ON execution_records(status);
CREATE INDEX idx_exec_workflow ON execution_records(workflow_name);

CREATE TABLE evaluation_records (
    id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    eval_type         TEXT NOT NULL CHECK (eval_type IN ('case_definition', 'run_result', 'metric_snapshot')),
    case_name         TEXT,
    scenario_type     TEXT,
    input_data        JSONB,
    expected_output   JSONB,
    actual_output     JSONB,
    score             REAL,
    metric_window     TSTZRANGE,
    metric_data       JSONB,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_eval_type ON evaluation_records(eval_type);

-- ============================================================
-- 外键补全：work_items 自引用
-- ============================================================

ALTER TABLE work_items
    ADD CONSTRAINT fk_work_items_primary_binding
    FOREIGN KEY (current_primary_binding_id) REFERENCES task_bindings(id);

ALTER TABLE work_items
    ADD CONSTRAINT fk_work_items_review_task
    FOREIGN KEY (current_review_task_id) REFERENCES human_review_tasks(id);

ALTER TABLE work_items
    ADD CONSTRAINT fk_work_items_responsible_hub
    FOREIGN KEY (responsible_hub_id) REFERENCES item_hubs(id) ON DELETE SET NULL;

ALTER TABLE work_item_audit_log
    ADD CONSTRAINT fk_audit_execution
    FOREIGN KEY (execution_record_id) REFERENCES execution_records(id);

ALTER TABLE knowledge_artifacts
    ADD CONSTRAINT fk_artifacts_trigger_policy
    FOREIGN KEY (trigger_policy_id) REFERENCES trigger_policies(id);

ALTER TABLE task_bindings
    ADD CONSTRAINT fk_task_bindings_hub
    FOREIGN KEY (hub_id) REFERENCES item_hubs(id) ON DELETE SET NULL;

ALTER TABLE task_bindings
    ADD CONSTRAINT fk_task_bindings_projection
    FOREIGN KEY (projection_id) REFERENCES work_item_hub_projections(id) ON DELETE SET NULL;
