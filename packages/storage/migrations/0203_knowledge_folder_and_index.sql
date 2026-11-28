-- pibot:rebuild-referenced-tables
-- Support plain local document folders ('folder') alongside Obsidian vaults and Notion, and store
-- a local-only full-text index (SQLite FTS5) for CJK/English BM25 search over local sources.

CREATE TABLE knowledge_sources_v2 (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('obsidian','notion','folder')),
  name TEXT NOT NULL,
  config_json TEXT NOT NULL CHECK(json_valid(config_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_used_at TEXT,
  targets_all INTEGER NOT NULL DEFAULT 0 CHECK (targets_all IN (0, 1)),
  account_json TEXT,
  writable INTEGER NOT NULL DEFAULT 0 CHECK(writable IN (0, 1))
);

INSERT INTO knowledge_sources_v2(
  id, kind, name, config_json, created_at, updated_at, last_used_at, targets_all, account_json, writable
)
SELECT
  id, kind, name, config_json, created_at, updated_at, last_used_at, targets_all, account_json, writable
FROM knowledge_sources;

DROP TABLE knowledge_sources;
ALTER TABLE knowledge_sources_v2 RENAME TO knowledge_sources;
CREATE INDEX knowledge_sources_page ON knowledge_sources(created_at DESC, id DESC);

-- Local full-text index for Obsidian vaults and local document folders. Stays strictly on this
-- computer in Pi Bot's private database; every search hit still re-checks read_file policy and
-- current file identity before returning snippets.
CREATE TABLE knowledge_index_files (
  id INTEGER PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES knowledge_sources(id) ON DELETE CASCADE,
  root_path TEXT NOT NULL,
  root_device TEXT NOT NULL,
  root_inode TEXT NOT NULL,
  rel_path TEXT NOT NULL,
  ext TEXT NOT NULL,
  device TEXT NOT NULL,
  inode TEXT NOT NULL,
  mtime_ns TEXT NOT NULL,
  ctime_ns TEXT NOT NULL,
  size INTEGER NOT NULL,
  scanned INTEGER NOT NULL DEFAULT 0 CHECK(scanned IN (0, 1)),
  unreadable INTEGER NOT NULL DEFAULT 0 CHECK(unreadable IN (0, 1)),
  truncated INTEGER NOT NULL DEFAULT 0 CHECK(truncated IN (0, 1)),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  title_tokens TEXT NOT NULL,
  body_tokens TEXT NOT NULL,
  indexed_at TEXT NOT NULL,
  scan_id TEXT NOT NULL DEFAULT '',
  UNIQUE(source_id, rel_path)
);
CREATE INDEX knowledge_index_files_source ON knowledge_index_files(source_id);

CREATE TABLE knowledge_index_walks (
  source_id TEXT PRIMARY KEY REFERENCES knowledge_sources(id) ON DELETE CASCADE,
  root_path TEXT NOT NULL,
  root_device TEXT NOT NULL,
  root_inode TEXT NOT NULL,
  revision TEXT NOT NULL,
  scan_id TEXT NOT NULL,
  position_json TEXT NOT NULL CHECK(json_valid(position_json)),
  can_prune INTEGER NOT NULL CHECK(can_prune IN (0, 1))
);

CREATE VIRTUAL TABLE knowledge_index_fts USING fts5(
  title_tokens,
  body_tokens,
  content='knowledge_index_files',
  content_rowid='id',
  tokenize='unicode61'
);
INSERT INTO knowledge_index_fts(knowledge_index_fts, rank) VALUES('secure-delete', 1);

CREATE TRIGGER knowledge_index_fts_insert AFTER INSERT ON knowledge_index_files BEGIN
  INSERT INTO knowledge_index_fts(rowid, title_tokens, body_tokens)
    VALUES(NEW.id, NEW.title_tokens, NEW.body_tokens);
END;

CREATE TRIGGER knowledge_index_fts_delete AFTER DELETE ON knowledge_index_files BEGIN
  INSERT INTO knowledge_index_fts(knowledge_index_fts, rowid, title_tokens, body_tokens)
    VALUES('delete', OLD.id, OLD.title_tokens, OLD.body_tokens);
END;

CREATE TRIGGER knowledge_index_fts_update AFTER UPDATE OF title_tokens, body_tokens ON knowledge_index_files
WHEN OLD.title_tokens IS NOT NEW.title_tokens OR OLD.body_tokens IS NOT NEW.body_tokens BEGIN
  INSERT INTO knowledge_index_fts(knowledge_index_fts, rowid, title_tokens, body_tokens)
    VALUES('delete', OLD.id, OLD.title_tokens, OLD.body_tokens);
  INSERT INTO knowledge_index_fts(rowid, title_tokens, body_tokens)
    VALUES(NEW.id, NEW.title_tokens, NEW.body_tokens);
END;
