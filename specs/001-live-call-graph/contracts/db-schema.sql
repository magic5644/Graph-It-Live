-- db-schema.sql
-- SQLite schema for the Live Call Graph in-memory database (sql.js)
--
-- SPEC REFERENCE: specs/001-live-call-graph/spec.md — FR-005, FR-006, FR-007
-- DATA MODEL:     specs/001-live-call-graph/data-model.md
--
-- All tables are created with IF NOT EXISTS so the schema is idempotent.
-- The database is reconstructed in-memory at extension start.
-- All timestamps are Unix milliseconds (INTEGER).

PRAGMA journal_mode = MEMORY;
PRAGMA synchronous = OFF;
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- Table: file_index
-- Tracks which files have been indexed and when.
-- Used for incremental invalidation on onDidSaveTextDocument.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS file_index (
    path          TEXT     NOT NULL,  -- Normalized absolute file path (PK)
    lang          TEXT     NOT NULL,  -- Language key: typescript | javascript | python | rust
    last_modified INTEGER  NOT NULL,  -- File mtime at last indexation (ms)
    indexed_at    INTEGER  NOT NULL,  -- When the extension indexed this file (ms)
    PRIMARY KEY (path)
);

-- ---------------------------------------------------------------------------
-- Table: nodes
-- Represents symbols (functions, classes, methods, interfaces, types, variables)
-- extracted by the GraphExtractor from source files via Tree-sitter WASM queries.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS nodes (
    id          TEXT     NOT NULL,  -- Stable ID: normalizedFilePath:symbolName:startLine
    name        TEXT     NOT NULL,  -- Symbol's bare name (e.g. fetchUsers, AuthService)
    type        TEXT     NOT NULL    -- One of: function | class | method | interface | type | variable
                         CHECK (type IN ('function','class','method','interface','type','variable')),
    lang        TEXT     NOT NULL,  -- Language key matching LANGUAGE_COLORS
    path        TEXT     NOT NULL,  -- Normalized absolute file path
    folder      TEXT     NOT NULL,  -- Workspace-relative folder (for compound nodes)
    start_line  INTEGER  NOT NULL,  -- 0-based start line
    end_line    INTEGER  NOT NULL,  -- 0-based end line
    start_col   INTEGER  NOT NULL,  -- 0-based start column
    is_exported INTEGER  NOT NULL DEFAULT 0,  -- Boolean (0/1)
    indexed_at  INTEGER  NOT NULL,  -- Unix ms

    PRIMARY KEY (id),
    FOREIGN KEY (path) REFERENCES file_index(path) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_nodes_path   ON nodes(path);
CREATE INDEX IF NOT EXISTS idx_nodes_folder ON nodes(folder);
CREATE INDEX IF NOT EXISTS idx_nodes_type   ON nodes(type);

-- ---------------------------------------------------------------------------
-- Table: edges
-- Represents directional relationships between symbols.
-- Composite PK prevents duplicate edges for the same relation type.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS edges (
    source_id     TEXT     NOT NULL,  -- Caller / child / user symbol id
    target_id     TEXT     NOT NULL,  -- Callee / parent / referenced symbol id
    type_relation TEXT     NOT NULL   -- One of: CALLS | INHERITS | IMPLEMENTS | USES
                           CHECK (type_relation IN ('CALLS','INHERITS','IMPLEMENTS','USES')),
    is_cyclic     INTEGER  NOT NULL DEFAULT 0,  -- Boolean (0/1)
    source_line   INTEGER  NOT NULL,  -- Line in source_id's file where the reference occurs
    indexed_at    INTEGER  NOT NULL,  -- Unix ms

    PRIMARY KEY (source_id, target_id, type_relation),
    FOREIGN KEY (source_id) REFERENCES nodes(id) ON DELETE CASCADE,
    FOREIGN KEY (target_id) REFERENCES nodes(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_edges_source   ON edges(source_id);
CREATE INDEX IF NOT EXISTS idx_edges_target   ON edges(target_id);
CREATE INDEX IF NOT EXISTS idx_edges_cyclic   ON edges(is_cyclic) WHERE is_cyclic = 1;

-- ---------------------------------------------------------------------------
-- Neighbourhood query (BFS depth-2, for reference — executed in TypeScript)
-- ---------------------------------------------------------------------------
-- Depth-1 neighbours of a root symbol:
--   SELECT n.*
--   FROM nodes n
--   JOIN edges e ON (e.source_id = :rootId AND e.target_id = n.id)
--               OR  (e.target_id = :rootId AND e.source_id = n.id)
--   WHERE n.id != :rootId;

-- Depth-2 neighbourhood (CTE):
--   WITH depth1 AS (
--     SELECT target_id AS id FROM edges WHERE source_id = :rootId
--     UNION
--     SELECT source_id AS id FROM edges WHERE target_id = :rootId
--   ),
--   depth2 AS (
--     SELECT e.target_id AS id FROM edges e JOIN depth1 d ON e.source_id = d.id
--     UNION
--     SELECT e.source_id AS id FROM edges e JOIN depth1 d ON e.target_id = d.id
--   )
--   SELECT DISTINCT n.* FROM nodes n
--   JOIN (SELECT id FROM depth1 UNION SELECT id FROM depth2) combined ON n.id = combined.id;
