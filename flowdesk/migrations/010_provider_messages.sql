-- Provider attribution is observational metadata, outside manual project history.
CREATE TABLE planning_message_sources (
    message_id TEXT PRIMARY KEY REFERENCES planning_messages(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    model TEXT
);
