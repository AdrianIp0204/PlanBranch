CREATE TABLE IF NOT EXISTS source_attachments (
    project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    root TEXT NOT NULL, ignores TEXT NOT NULL, generation TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS source_files (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    path TEXT NOT NULL, data TEXT NOT NULL,
    PRIMARY KEY(project_id,path)
);
CREATE TABLE IF NOT EXISTS scan_runs (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS detected_symbols (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS detected_symbols_project ON detected_symbols(project_id);
CREATE INDEX IF NOT EXISTS scan_runs_project ON scan_runs(project_id);
