CREATE TABLE writing_drafts (
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 id TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision > 0),
 payload TEXT NOT NULL,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 PRIMARY KEY(project_id,id)
);
CREATE TABLE writing_draft_receipts (
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 mutation_id TEXT NOT NULL,
 payload_hash TEXT NOT NULL,
 response TEXT NOT NULL,
 status_code INTEGER NOT NULL,
 PRIMARY KEY(project_id,mutation_id)
);
