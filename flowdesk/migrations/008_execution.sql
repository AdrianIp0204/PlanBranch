CREATE TABLE execution_repositories (
    project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    id TEXT NOT NULL UNIQUE,
    repository TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE execution_previews (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    snapshot TEXT NOT NULL,
    ready INTEGER NOT NULL CHECK(ready IN (0,1)),
    issues TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX execution_previews_project ON execution_previews(project_id,created_at);
CREATE TABLE execution_runs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    preview_id TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL CHECK(state IN ('queued','running','cancelling','succeeded','failed','cancelled','interrupted')),
    snapshot TEXT NOT NULL,
    workspace TEXT,
    artifact_digest TEXT,
    commands TEXT NOT NULL DEFAULT '[]',
    events TEXT NOT NULL DEFAULT '[]',
    summary TEXT NOT NULL DEFAULT '',
    error TEXT,
    progress TEXT NOT NULL DEFAULT '',
    accepted_digest TEXT,
    completed_cursor TEXT,
    applied INTEGER NOT NULL DEFAULT 0 CHECK(applied IN (0,1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX execution_runs_project ON execution_runs(project_id,created_at);
CREATE UNIQUE INDEX execution_one_active ON execution_runs((1)) WHERE state IN ('queued','running','cancelling');
CREATE TABLE execution_receipts (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    mutation_id TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    action TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('pending','done','failed')),
    result TEXT,
    PRIMARY KEY(project_id,mutation_id)
);
