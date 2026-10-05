/**
 * SQLite storage for the documentation index.
 *
 * Uses Node's built-in `node:sqlite`, which ships FTS5 (with `bm25()` and
 * `snippet()`) — so the package has no native dependency and `npx` never has
 * to compile anything.
 *
 * All SQL lives behind this class so a different backend can be added later
 * without touching the indexer, the CLI or the MCP tools.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';

import { deserializeVector, serializeVector } from '../embeddings/provider.js';
import type { ParsedChunk } from './parser.js';

/** Bumping this rebuilds the index, which is a derived cache and safe to drop. */
const SCHEMA_VERSION = 1;

export interface StoredDocument {
  id: string;
  docsLine: string;
  lang: string;
  title: string;
  heading?: string;
  anchor?: string;
  section: string;
  url: string;
  path: string;
  content: string;
  hash: string;
  updatedAt: string;
}

export interface SearchHit extends StoredDocument {
  /**
   * bm25's own convention: negative, and *lower* (more negative) is better.
   * Hybrid results are the opposite — a reciprocal-rank-fusion score where
   * *higher* is better. Compare scores only within one search call, never
   * across strategies.
   */
  score: number;
  snippet: string;
}

export interface ManualVersionRow {
  docsLine: string;
  lang: string;
  commit?: string;
  source?: string;
  syncedAt?: string;
  indexedAt?: string;
  documentCount: number;
}

type Row = Record<string, unknown>;

function text(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

function optionalText(value: unknown): string | undefined {
  const result = text(value);
  return result === '' ? undefined : result;
}

function toDocument(row: Row): StoredDocument {
  return {
    id: text(row.id),
    docsLine: text(row.doc_line),
    lang: text(row.lang),
    title: text(row.title),
    heading: optionalText(row.heading),
    anchor: optionalText(row.anchor),
    section: text(row.section),
    url: text(row.url),
    path: text(row.path),
    content: text(row.content),
    hash: text(row.hash),
    updatedAt: text(row.updated_at),
  };
}

export class ManualRepository {
  /** Prepared once on first use — see `upsertVector`. */
  private upsertVectorStatement?: StatementSync;

  private constructor(private readonly db: DatabaseSync) {}

  static open(indexFile: string): ManualRepository {
    mkdirSync(path.dirname(indexFile), { recursive: true });
    const db = new DatabaseSync(indexFile);
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA foreign_keys = ON;');

    const repository = new ManualRepository(db);
    repository.migrate();
    return repository;
  }

  /** In-memory database, used by the test suite. */
  static openInMemory(): ManualRepository {
    const db = new DatabaseSync(':memory:');
    const repository = new ManualRepository(db);
    repository.migrate();
    return repository;
  }

  private migrate(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS index_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);

    const current = this.db.prepare(`SELECT value FROM index_meta WHERE key = 'schema_version'`).get() as
      | Row
      | undefined;
    const version = current ? Number(text(current.value)) : 0;

    if (version !== 0 && version !== SCHEMA_VERSION) {
      // The index is a rebuildable cache; dropping is cheaper than migrating.
      this.db.exec(`DROP TABLE IF EXISTS documents_fts;`);
      this.db.exec(`DROP TABLE IF EXISTS documents;`);
      this.db.exec(`DROP TABLE IF EXISTS manual_versions;`);
      this.db.exec(`DROP TABLE IF EXISTS document_vectors;`);
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        id         TEXT PRIMARY KEY,
        doc_line   TEXT NOT NULL,
        lang       TEXT NOT NULL,
        title      TEXT NOT NULL,
        heading    TEXT,
        anchor     TEXT,
        section    TEXT NOT NULL,
        url        TEXT NOT NULL,
        path       TEXT NOT NULL,
        content    TEXT NOT NULL,
        hash       TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS documents_line_idx ON documents (doc_line, lang);
      CREATE INDEX IF NOT EXISTS documents_path_idx ON documents (doc_line, lang, path);

      CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5 (
        title, heading, section, content,
        content = 'documents',
        content_rowid = 'rowid',
        tokenize = 'porter unicode61'
      );

      CREATE TRIGGER IF NOT EXISTS documents_ai AFTER INSERT ON documents BEGIN
        INSERT INTO documents_fts (rowid, title, heading, section, content)
        VALUES (new.rowid, new.title, new.heading, new.section, new.content);
      END;

      CREATE TRIGGER IF NOT EXISTS documents_ad AFTER DELETE ON documents BEGIN
        INSERT INTO documents_fts (documents_fts, rowid, title, heading, section, content)
        VALUES ('delete', old.rowid, old.title, old.heading, old.section, old.content);
      END;

      CREATE TRIGGER IF NOT EXISTS documents_au AFTER UPDATE ON documents BEGIN
        INSERT INTO documents_fts (documents_fts, rowid, title, heading, section, content)
        VALUES ('delete', old.rowid, old.title, old.heading, old.section, old.content);
        INSERT INTO documents_fts (rowid, title, heading, section, content)
        VALUES (new.rowid, new.title, new.heading, new.section, new.content);
      END;

      CREATE TABLE IF NOT EXISTS manual_versions (
        doc_line       TEXT NOT NULL,
        lang           TEXT NOT NULL,
        commit_sha     TEXT,
        source         TEXT,
        synced_at      TEXT,
        indexed_at     TEXT,
        document_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (doc_line, lang)
      );

      -- Embeddings for hybrid search. Keyed by (id, model) rather than a column
      -- on 'documents' so switching embedding models never mixes vectors from
      -- two different models under one id, and an old model's vectors are just
      -- unused rows rather than something that needs an eager migration.
      CREATE TABLE IF NOT EXISTS document_vectors (
        id     TEXT NOT NULL,
        model  TEXT NOT NULL,
        dims   INTEGER NOT NULL,
        vector BLOB NOT NULL,
        PRIMARY KEY (id, model)
      );
    `);

    this.db
      .prepare(`INSERT OR REPLACE INTO index_meta (key, value) VALUES ('schema_version', ?)`)
      .run(String(SCHEMA_VERSION));
  }

  close(): void {
    this.db.close();
  }

  transaction<T>(work: () => T): T {
    this.db.exec('BEGIN');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** id -> hash for a corpus, used to decide what actually needs reindexing. */
  hashesFor(docsLine: string, lang: string): Map<string, string> {
    const rows = this.db
      .prepare(`SELECT id, hash FROM documents WHERE doc_line = ? AND lang = ?`)
      .all(docsLine, lang) as Row[];

    return new Map(rows.map((row) => [text(row.id), text(row.hash)]));
  }

  insert(chunk: ParsedChunk, updatedAt: string): void {
    this.db
      .prepare(
        `INSERT INTO documents (id, doc_line, lang, title, heading, anchor, section, url, path, content, hash, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        chunk.id,
        chunk.docsLine,
        chunk.lang,
        chunk.title,
        chunk.heading ?? null,
        chunk.anchor ?? null,
        chunk.section,
        chunk.url,
        chunk.path,
        chunk.content,
        chunk.hash,
        updatedAt,
      );
  }

  update(chunk: ParsedChunk, updatedAt: string): void {
    this.db
      .prepare(
        `UPDATE documents
            SET title = ?, heading = ?, anchor = ?, section = ?, url = ?, path = ?,
                content = ?, hash = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(
        chunk.title,
        chunk.heading ?? null,
        chunk.anchor ?? null,
        chunk.section,
        chunk.url,
        chunk.path,
        chunk.content,
        chunk.hash,
        updatedAt,
        chunk.id,
      );
  }

  deleteByIds(ids: readonly string[]): void {
    const statement = this.db.prepare(`DELETE FROM documents WHERE id = ?`);
    const deleteVectors = this.db.prepare(`DELETE FROM document_vectors WHERE id = ?`);
    for (const id of ids) {
      statement.run(id);
      deleteVectors.run(id);
    }
  }

  deleteCorpus(docsLine: string, lang?: string): number {
    // Vectors have no doc_line/lang of their own, so delete by the ids that
    // belong to this corpus before the documents themselves are gone.
    const ids = (
      lang
        ? this.db.prepare(`SELECT id FROM documents WHERE doc_line = ? AND lang = ?`).all(docsLine, lang)
        : this.db.prepare(`SELECT id FROM documents WHERE doc_line = ?`).all(docsLine)
    ) as Row[];
    const deleteVectors = this.db.prepare(`DELETE FROM document_vectors WHERE id = ?`);
    for (const row of ids) {
      deleteVectors.run(text(row.id));
    }

    const result = lang
      ? this.db.prepare(`DELETE FROM documents WHERE doc_line = ? AND lang = ?`).run(docsLine, lang)
      : this.db.prepare(`DELETE FROM documents WHERE doc_line = ?`).run(docsLine);
    return Number(result.changes ?? 0);
  }

  countDocuments(docsLine?: string, lang?: string): number {
    const row = (
      docsLine && lang
        ? this.db
            .prepare(`SELECT COUNT(*) AS n FROM documents WHERE doc_line = ? AND lang = ?`)
            .get(docsLine, lang)
        : docsLine
          ? this.db.prepare(`SELECT COUNT(*) AS n FROM documents WHERE doc_line = ?`).get(docsLine)
          : this.db.prepare(`SELECT COUNT(*) AS n FROM documents`).get()
    ) as Row | undefined;

    return row ? Number(row.n ?? 0) : 0;
  }

  getDocument(id: string): StoredDocument | undefined {
    const row = this.db.prepare(`SELECT * FROM documents WHERE id = ?`).get(id) as Row | undefined;
    return row ? toDocument(row) : undefined;
  }

  /**
   * Stores (or replaces) a chunk's embedding for one model.
   *
   * The statement is prepared once and reused: this runs once per chunk across
   * a whole corpus, so re-preparing it every call is pure overhead.
   */
  upsertVector(id: string, model: string, vector: Float32Array): void {
    this.upsertVectorStatement ??= this.db.prepare(
      `INSERT INTO document_vectors (id, model, dims, vector) VALUES (?, ?, ?, ?)
       ON CONFLICT (id, model) DO UPDATE SET dims = excluded.dims, vector = excluded.vector`,
    );
    this.upsertVectorStatement.run(id, model, vector.length, serializeVector(vector));
  }

  /** Whether this corpus has at least one embedding for the given model. */
  hasVectors(docsLine: string, lang: string, model: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM document_vectors v
           JOIN documents d ON d.id = v.id
          WHERE v.model = ? AND d.doc_line = ? AND d.lang = ?
          LIMIT 1`,
      )
      .get(model, docsLine, lang);
    return row !== undefined;
  }

  /**
   * Ids in this corpus that already have an embedding for the given model.
   *
   * This is what makes embedding resumable, and what makes opting into hybrid
   * search on an already-indexed corpus work at all: content hashes alone say
   * a chunk is unchanged, which is true, but says nothing about whether a
   * vector for it exists yet.
   */
  idsWithVectors(docsLine: string, lang: string, model: string): Set<string> {
    const rows = this.db
      .prepare(
        `SELECT v.id FROM document_vectors v
           JOIN documents d ON d.id = v.id
          WHERE v.model = ? AND d.doc_line = ? AND d.lang = ?`,
      )
      .all(model, docsLine, lang) as Row[];

    return new Set(rows.map((row) => text(row.id)));
  }

  /** How many of this corpus's documents have an embedding for the given model. */
  vectorCount(docsLine: string, lang: string, model: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM document_vectors v
           JOIN documents d ON d.id = v.id
          WHERE v.model = ? AND d.doc_line = ? AND d.lang = ?`,
      )
      .get(model, docsLine, lang) as Row | undefined;
    return row ? Number(row.n ?? 0) : 0;
  }

  /**
   * All vectors for one corpus and model, for a brute-force similarity scan.
   *
   * Corpora here run in the low thousands of documents, so a linear scan in
   * JS at query time is fast enough that a dedicated ANN index would be
   * solving a problem this tool does not have.
   */
  listVectors(docsLine: string, lang: string, model: string): Array<{ id: string; vector: Float32Array }> {
    const rows = this.db
      .prepare(
        `SELECT v.id, v.dims, v.vector FROM document_vectors v
           JOIN documents d ON d.id = v.id
          WHERE v.model = ? AND d.doc_line = ? AND d.lang = ?`,
      )
      .all(model, docsLine, lang) as Row[];

    return rows
      .map((row) => ({
        id: text(row.id),
        dims: Number(row.dims ?? 0),
        vector: deserializeVector(row.vector as Uint8Array),
      }))
      // `dims` is stored next to the blob precisely so a truncated or otherwise
      // corrupt row can be recognised here instead of being scored as if it
      // were a real vector.
      .filter((entry) => entry.vector.length === entry.dims)
      .map(({ id, vector }) => ({ id, vector }));
  }

  /**
   * Runs an FTS5 MATCH query. `matchExpression` must already be escaped —
   * see `buildMatchExpression` in search.ts.
   *
   * bm25() weights title and heading above body text so an exact page/section
   * name outranks a passing mention, and returns negative scores (better =
   * more negative), hence the ascending sort.
   */
  search(options: {
    matchExpression: string;
    docsLine: string;
    lang: string;
    limit: number;
  }): SearchHit[] {
    const rows = this.db
      .prepare(
        `SELECT d.*,
                bm25(documents_fts, 10.0, 6.0, 2.0, 1.0) AS score,
                snippet(documents_fts, 3, '', '', '…', 28)  AS excerpt
           FROM documents_fts
           JOIN documents d ON d.rowid = documents_fts.rowid
          WHERE documents_fts MATCH ?
            AND d.doc_line = ?
            AND d.lang = ?
          ORDER BY score
          LIMIT ?`,
      )
      .all(options.matchExpression, options.docsLine, options.lang, options.limit) as Row[];

    return rows.map((row) => ({
      ...toDocument(row),
      score: Number(row.score ?? 0),
      snippet: text(row.excerpt),
    }));
  }

  recordManualVersion(row: ManualVersionRow): void {
    this.db
      .prepare(
        `INSERT INTO manual_versions (doc_line, lang, commit_sha, source, synced_at, indexed_at, document_count)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (doc_line, lang) DO UPDATE SET
           commit_sha = excluded.commit_sha,
           source = excluded.source,
           synced_at = excluded.synced_at,
           indexed_at = excluded.indexed_at,
           document_count = excluded.document_count`,
      )
      .run(
        row.docsLine,
        row.lang,
        row.commit ?? null,
        row.source ?? null,
        row.syncedAt ?? null,
        row.indexedAt ?? null,
        row.documentCount,
      );
  }

  getManualVersion(docsLine: string, lang: string): ManualVersionRow | undefined {
    const row = this.db
      .prepare(`SELECT * FROM manual_versions WHERE doc_line = ? AND lang = ?`)
      .get(docsLine, lang) as Row | undefined;
    return row ? this.toManualVersion(row) : undefined;
  }

  listManualVersions(): ManualVersionRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM manual_versions ORDER BY doc_line, lang`)
      .all() as Row[];
    return rows.map((row) => this.toManualVersion(row));
  }

  private toManualVersion(row: Row): ManualVersionRow {
    return {
      docsLine: text(row.doc_line),
      lang: text(row.lang),
      commit: optionalText(row.commit_sha),
      source: optionalText(row.source),
      syncedAt: optionalText(row.synced_at),
      indexedAt: optionalText(row.indexed_at),
      documentCount: Number(row.document_count ?? 0),
    };
  }

  /** Reclaims space and rebuilds FTS internals after a large re-index. */
  optimize(): void {
    this.db.exec(`INSERT INTO documents_fts (documents_fts) VALUES ('optimize');`);
  }
}
