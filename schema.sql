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

ALTER TABLE work_item_audit_log
    ADD CONSTRAINT fk_audit_execution
    FOREIGN KEY (execution_record_id) REFERENCES execution_records(id);

ALTER TABLE knowledge_artifacts
    ADD CONSTRAINT fk_artifacts_trigger_policy
    FOREIGN KEY (trigger_policy_id) REFERENCES trigger_policies(id);
