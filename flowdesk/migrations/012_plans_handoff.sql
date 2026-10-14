CREATE TABLE plan_snapshots (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    alternative_id TEXT,
    kind TEXT NOT NULL CHECK(kind IN ('checkpoint','recovery','alternative')),
    name TEXT NOT NULL,
    explanation TEXT NOT NULL,
    content TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    source_references TEXT NOT NULL DEFAULT '[]',
    source_revision INTEGER NOT NULL,
    historical_approval_id TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX plan_snapshots_project ON plan_snapshots(project_id,created_at);
CREATE TABLE plan_alternatives (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    parent_id TEXT,
    name TEXT NOT NULL,
    snapshot_id TEXT NOT NULL REFERENCES plan_snapshots(id),
    created_at TEXT NOT NULL
);
CREATE TABLE plan_selection (
    project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    alternative_id TEXT NOT NULL REFERENCES plan_alternatives(id),
    epoch INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE plan_decisions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    alternative_id TEXT,
    snapshot_id TEXT,
    action TEXT NOT NULL,
    note TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE plan_receipts (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    mutation_id TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    result TEXT NOT NULL,
    PRIMARY KEY(project_id,mutation_id)
);
CREATE TABLE task_handoffs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    task_id TEXT NOT NULL,
    manifest TEXT NOT NULL,
    manifest_hash TEXT NOT NULL,
    repository TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX task_handoffs_project ON task_handoffs(project_id,task_id,created_at);
CREATE TABLE external_results (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    handoff_id TEXT NOT NULL REFERENCES task_handoffs(id),
    task_id TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE external_reviews (
    id TEXT PRIMARY KEY,
    result_id TEXT NOT NULL REFERENCES external_results(id) ON DELETE CASCADE,
    decision TEXT NOT NULL CHECK(decision IN ('accepted','changes_requested')),
    note TEXT NOT NULL,
    created_at TEXT NOT NULL
);
