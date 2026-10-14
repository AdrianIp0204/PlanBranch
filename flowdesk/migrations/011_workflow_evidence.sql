ALTER TABLE planning_approvals ADD COLUMN scope_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE execution_runs ADD COLUMN rejected_digest TEXT;
ALTER TABLE execution_runs ADD COLUMN candidate_snapshot TEXT;
CREATE TABLE trace_reviews (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    task_id TEXT NOT NULL,
    criterion_id TEXT NOT NULL,
    criterion_hash TEXT NOT NULL,
    requirement_hash TEXT NOT NULL,
    run_id TEXT NOT NULL REFERENCES execution_runs(id) ON DELETE CASCADE,
    candidate_hash TEXT NOT NULL,
    command_id TEXT,
    file_paths TEXT NOT NULL DEFAULT '[]',
    note TEXT NOT NULL,
    created_at TEXT NOT NULL,
    mutation_id TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    UNIQUE(project_id,mutation_id)
);
CREATE INDEX trace_reviews_task ON trace_reviews(project_id,task_id,created_at);
