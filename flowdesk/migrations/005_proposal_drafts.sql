CREATE UNIQUE INDEX planning_proposals_owner ON planning_proposals(project_id,id);
CREATE TABLE proposal_drafts (
    id TEXT NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    proposal_id TEXT NOT NULL,
    diagram_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision > 0),
    state TEXT NOT NULL CHECK(state IN ('active','applying','applied','discarded')),
    base_revision INTEGER NOT NULL,
    base_hash TEXT NOT NULL,
    proposal_hash TEXT NOT NULL,
    candidate TEXT NOT NULL,
    conflict_of TEXT,
    apply_request TEXT,
    applied_cursor TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(project_id,id),
    FOREIGN KEY(project_id,proposal_id) REFERENCES planning_proposals(project_id,id) ON DELETE CASCADE
);
CREATE INDEX proposal_drafts_proposal ON proposal_drafts(project_id,proposal_id,updated_at,id);
CREATE TABLE proposal_draft_receipts (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    mutation_id TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    acknowledgement TEXT NOT NULL,
    status_code INTEGER NOT NULL CHECK(status_code IN (200,409)),
    PRIMARY KEY(project_id,mutation_id)
);
