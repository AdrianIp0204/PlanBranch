CREATE TABLE planning_question_sets (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    request_id TEXT NOT NULL,
    message_id TEXT NOT NULL REFERENCES planning_messages(id) ON DELETE CASCADE,
    diagram_id TEXT NOT NULL,
    node_id TEXT,
    base_hash TEXT NOT NULL,
    protocol_version INTEGER NOT NULL CHECK(protocol_version=2),
    questions TEXT NOT NULL,
    answers TEXT,
    state TEXT NOT NULL CHECK(state IN ('open','answered','superseded')),
    created_at TEXT NOT NULL,
    answered_at TEXT,
    continuation_request_id TEXT,
    FOREIGN KEY(project_id,request_id) REFERENCES planning_requests(project_id,id) ON DELETE CASCADE,
    FOREIGN KEY(project_id,continuation_request_id) REFERENCES planning_requests(project_id,id)
);
CREATE UNIQUE INDEX planning_one_open_question_set ON planning_question_sets(project_id) WHERE state='open';
CREATE INDEX planning_question_sets_project ON planning_question_sets(project_id,created_at,id);
