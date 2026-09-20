CREATE TABLE planning_messages (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK(role IN ('user','assistant')),
    text TEXT NOT NULL,
    created_at TEXT NOT NULL,
    diagram_id TEXT,
    node_id TEXT,
    node_title TEXT,
    proposal_id TEXT
);
CREATE INDEX planning_messages_project ON planning_messages(project_id,created_at,id);
CREATE TABLE planning_comments (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    diagram_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    node_title TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL,
    resolved INTEGER NOT NULL DEFAULT 0 CHECK(resolved IN (0,1))
);
CREATE INDEX planning_comments_project ON planning_comments(project_id,created_at,id);
CREATE TABLE planning_requests (
    id TEXT NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    payload_hash TEXT NOT NULL,
    payload TEXT NOT NULL,
    context TEXT NOT NULL,
    base_revision INTEGER NOT NULL,
    base_cursor TEXT NOT NULL,
    base_hash TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('running','failed','succeeded')),
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(project_id,id)
);
CREATE UNIQUE INDEX planning_one_active_request ON planning_requests(project_id) WHERE status='running';
CREATE TABLE planning_proposals (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    diagram_id TEXT NOT NULL,
    base_revision INTEGER NOT NULL,
    base_cursor TEXT NOT NULL,
    base_hash TEXT NOT NULL,
    content TEXT NOT NULL,
    changes TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('pending','accepted','rejected')),
    created_at TEXT NOT NULL
);
CREATE INDEX planning_proposals_project ON planning_proposals(project_id,created_at,id);
CREATE TABLE planning_approvals (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL,
    cursor TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL,
    revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0,1))
);
CREATE INDEX planning_approvals_project ON planning_approvals(project_id,created_at,id);
CREATE TABLE planning_receipts (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    mutation_id TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    PRIMARY KEY(project_id,mutation_id)
);
