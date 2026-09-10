CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL
);
CREATE TABLE projects (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, notes TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision >= 0), saved_at TEXT NOT NULL,
    cursor TEXT NOT NULL
);
CREATE TABLE diagrams (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL, ordinal INTEGER NOT NULL
);
CREATE TABLE nodes (
    id TEXT PRIMARY KEY, diagram_id TEXT NOT NULL REFERENCES diagrams(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL, type TEXT NOT NULL, title TEXT NOT NULL,
    x REAL NOT NULL, y REAL NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL
);
CREATE TABLE edges (
    id TEXT PRIMARY KEY, diagram_id TEXT NOT NULL REFERENCES diagrams(id) ON DELETE CASCADE,
    source_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    target_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL, data TEXT NOT NULL
);
CREATE TABLE checklist_items (
    id TEXT PRIMARY KEY, node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL, text TEXT NOT NULL, checked INTEGER NOT NULL CHECK(checked IN (0,1))
);
CREATE TABLE planned_variables (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL
);
CREATE TABLE planned_node_links (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    variable_id TEXT NOT NULL REFERENCES planned_variables(id) ON DELETE CASCADE,
    relationship TEXT NOT NULL, UNIQUE(node_id,variable_id)
);
CREATE TABLE detected_symbols (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    data TEXT NOT NULL
);
CREATE TABLE detected_node_links (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    symbol_id TEXT NOT NULL REFERENCES detected_symbols(id) ON DELETE RESTRICT,
    relationship TEXT NOT NULL, UNIQUE(node_id,symbol_id)
);
CREATE TABLE symbol_matches (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    planned_id TEXT NOT NULL REFERENCES planned_variables(id) ON DELETE CASCADE,
    symbol_id TEXT NOT NULL REFERENCES detected_symbols(id) ON DELETE RESTRICT,
    decision TEXT NOT NULL, UNIQUE(planned_id,symbol_id)
);
CREATE TABLE history_checkpoints (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    id TEXT NOT NULL, ordinal INTEGER NOT NULL, label TEXT NOT NULL,
    diagram_id TEXT, schema_version INTEGER NOT NULL, content TEXT NOT NULL,
    PRIMARY KEY(project_id,id), UNIQUE(project_id,ordinal)
);
CREATE TABLE diagram_views (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    diagram_id TEXT NOT NULL, x REAL NOT NULL, y REAL NOT NULL, zoom REAL NOT NULL,
    PRIMARY KEY(project_id,diagram_id)
);
CREATE TABLE save_receipts (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    mutation_id TEXT NOT NULL, payload_hash TEXT NOT NULL, acknowledgement TEXT NOT NULL,
    PRIMARY KEY(project_id,mutation_id)
);
CREATE INDEX nodes_diagram ON nodes(diagram_id);
CREATE INDEX diagrams_project ON diagrams(project_id);
CREATE INDEX variables_project ON planned_variables(project_id);
