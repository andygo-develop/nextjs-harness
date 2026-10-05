/**
 * Storage for the project spec index.
 *
 * Deliberately a **separate SQLite file** from the framework manual index.
 * The whole point of this tool is never to blur framework documentation with
 * anything else, and separate databases make that structurally impossible
 * rather than dependent on getting a WHERE clause right.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';

import { deserializeVector, serializeVector } from '../embeddings/provider.js';
import type { SpecChunk } from './parser.js';

const SCHEMA_VERSION = 1;

export interface StoredSpec {
  id: string;
  path: string;
  title: string;
  heading?: string;
  anchor?: string;
  section: string;
  content: string;
  hash: string;
  updatedAt: string;
}

export interface SpecHit extends StoredSpec {
  /** See the score doc-comment on manuals' SearchHit — same dual convention. */
  score: number;
  snippet: string;
}

type Row = Record<string, unknown>;

function text(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

function optionalText(value: unknown): string | undefined {
  const result = text(value);
  return result === '' ? undefined : result;
}

function toSpec(row: Row): StoredSpec {
  return {
    id: text(row.id),
    path: text(row.path),
    title: text(row.title),
    heading: optionalText(row.heading),
    anchor: optionalText(row.anchor),
    section: text(row.section),
    content: text(row.content),
    hash: text(row.hash),
    updatedAt: text(row.updated_at),
  };
}

export class SpecRepository {
  /** Prepared once on first use — see the manual repository's upsertVector. */
  private upsertVectorStatement?: StatementSync;

  private constructor(private readonly db: DatabaseSync) {}

  static open(indexFile: string): SpecRepository {
    mkdirSync(path.dirname(indexFile), { recursive: true });
    const db = new DatabaseSync(indexFile);
    db.exec('PRAGMA journal_mode = WAL;');

    const repository = new SpecRepository(db);
    repository.migrate();
    return repository;
  }

  static openInMemory(): SpecRepository {
    const repository = new SpecRepository(new DatabaseSync(':memory:'));
    repository.migrate();
    return repository;
  }

  private migrate(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS spec_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);

    const current = this.db.prepare(`SELECT value FROM spec_meta WHERE key = 'schema_version'`).get() as
      | Row
      | undefined;
    const version = current ? Number(text(current.value)) : 0;

    if (version !== 0 && version !== SCHEMA_VERSION) {
      this.db.exec(`DROP TABLE IF EXISTS specs_fts;`);
      this.db.exec(`DROP TABLE IF EXISTS specs;`);
      this.db.exec(`DROP TABLE IF EXISTS spec_vectors;`);
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS specs (
        id         TEXT PRIMARY KEY,
        path       TEXT NOT NULL,
        title      TEXT NOT NULL,
        heading    TEXT,
        anchor     TEXT,
        section    TEXT NOT NULL,
        content    TEXT NOT NULL,
        hash       TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS specs_path_idx ON specs (path);

      CREATE VIRTUAL TABLE IF NOT EXISTS specs_fts USING fts5 (
        title, heading, section, content,
        content = 'specs',
        content_rowid = 'rowid',
        tokenize = 'porter unicode61'
      );

      CREATE TRIGGER IF NOT EXISTS specs_ai AFTER INSERT ON specs BEGIN
        INSERT INTO specs_fts (rowid, title, heading, section, content)
        VALUES (new.rowid, new.title, new.heading, new.section, new.content);
      END;

      CREATE TRIGGER IF NOT EXISTS specs_ad AFTER DELETE ON specs BEGIN
        INSERT INTO specs_fts (specs_fts, rowid, title, heading, section, content)
        VALUES ('delete', old.rowid, old.title, old.heading, old.section, old.content);
      END;

      CREATE TRIGGER IF NOT EXISTS specs_au AFTER UPDATE ON specs BEGIN
        INSERT INTO specs_fts (specs_fts, rowid, title, heading, section, content)
        VALUES ('delete', old.rowid, old.title, old.heading, old.section, old.content);
        INSERT INTO specs_fts (rowid, title, heading, section, content)
        VALUES (new.rowid, new.title, new.heading, new.section, new.content);
      END;

      -- See document_vectors in the manual repository for why this is keyed by
      -- (id, model) rather than a column on 'specs'.
      CREATE TABLE IF NOT EXISTS spec_vectors (
        id     TEXT NOT NULL,
        model  TEXT NOT NULL,
        dims   INTEGER NOT NULL,
        vector BLOB NOT NULL,
        PRIMARY KEY (id, model)
      );
    `);

    this.db
      .prepare(`INSERT OR REPLACE INTO spec_meta (key, value) VALUES ('schema_version', ?)`)
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

  hashes(): Map<string, string> {
    const rows = this.db.prepare(`SELECT id, hash FROM specs`).all() as Row[];
    return new Map(rows.map((row) => [text(row.id), text(row.hash)]));
  }

  insert(chunk: SpecChunk, updatedAt: string): void {
    this.db
      .prepare(
        `INSERT INTO specs (id, path, title, heading, anchor, section, content, hash, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        chunk.id,
        chunk.path,
        chunk.title,
        chunk.heading ?? null,
        chunk.anchor ?? null,
        chunk.section,
        chunk.content,
        chunk.hash,
        updatedAt,
      );
  }

  update(chunk: SpecChunk, updatedAt: string): void {
    this.db
      .prepare(
        `UPDATE specs
            SET path = ?, title = ?, heading = ?, anchor = ?, section = ?,
                content = ?, hash = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(
        chunk.path,
        chunk.title,
        chunk.heading ?? null,
        chunk.anchor ?? null,
        chunk.section,
        chunk.content,
        chunk.hash,
        updatedAt,
        chunk.id,
      );
  }

  deleteByIds(ids: readonly string[]): void {
    const statement = this.db.prepare(`DELETE FROM specs WHERE id = ?`);
    const deleteVectors = this.db.prepare(`DELETE FROM spec_vectors WHERE id = ?`);
    for (const id of ids) {
      statement.run(id);
      deleteVectors.run(id);
    }
  }

  count(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM specs`).get() as Row | undefined;
    return row ? Number(row.n ?? 0) : 0;
  }

  countFiles(): number {
    const row = this.db.prepare(`SELECT COUNT(DISTINCT path) AS n FROM specs`).get() as Row | undefined;
    return row ? Number(row.n ?? 0) : 0;
  }

  get(id: string): StoredSpec | undefined {
    const row = this.db.prepare(`SELECT * FROM specs WHERE id = ?`).get(id) as Row | undefined;
    return row ? toSpec(row) : undefined;
  }

  /** Stores (or replaces) a chunk's embedding for one model. */
  upsertVector(id: string, model: string, vector: Float32Array): void {
    this.upsertVectorStatement ??= this.db.prepare(
      `INSERT INTO spec_vectors (id, model, dims, vector) VALUES (?, ?, ?, ?)
       ON CONFLICT (id, model) DO UPDATE SET dims = excluded.dims, vector = excluded.vector`,
    );
    this.upsertVectorStatement.run(id, model, vector.length, serializeVector(vector));
  }

  /** Whether this corpus has at least one embedding for the given model. */
  hasVectors(model: string): boolean {
    const row = this.db.prepare(`SELECT 1 FROM spec_vectors WHERE model = ? LIMIT 1`).get(model);
    return row !== undefined;
  }

  /** How many specs have an embedding for the given model. */
  vectorCount(model: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM spec_vectors v JOIN specs s ON s.id = v.id WHERE v.model = ?`,
      )
      .get(model) as Row | undefined;
    return row ? Number(row.n ?? 0) : 0;
  }

  /** See the manual repository's idsWithVectors — same purpose, specs' corpus. */
  idsWithVectors(model: string): Set<string> {
    const rows = this.db
      .prepare(`SELECT v.id FROM spec_vectors v JOIN specs s ON s.id = v.id WHERE v.model = ?`)
      .all(model) as Row[];
    return new Set(rows.map((row) => text(row.id)));
  }

  /** All vectors for one model — see the manual repository's listVectors. */
  listVectors(model: string): Array<{ id: string; vector: Float32Array }> {
    const rows = this.db.prepare(`SELECT id, dims, vector FROM spec_vectors WHERE model = ?`).all(model) as Row[];
    return rows
      .map((row) => ({
        id: text(row.id),
        dims: Number(row.dims ?? 0),
        vector: deserializeVector(row.vector as Uint8Array),
      }))
      .filter((entry) => entry.vector.length === entry.dims)
      .map(({ id, vector }) => ({ id, vector }));
  }

  search(matchExpression: string, limit: number): SpecHit[] {
    const rows = this.db
      .prepare(
        `SELECT s.*,
                bm25(specs_fts, 10.0, 6.0, 2.0, 1.0) AS score,
                snippet(specs_fts, 3, '', '', '…', 28) AS excerpt
           FROM specs_fts
           JOIN specs s ON s.rowid = specs_fts.rowid
          WHERE specs_fts MATCH ?
          ORDER BY score
          LIMIT ?`,
      )
      .all(matchExpression, limit) as Row[];

    return rows.map((row) => ({
      ...toSpec(row),
      score: Number(row.score ?? 0),
      snippet: text(row.excerpt),
    }));
  }

  setMeta(key: string, value: string): void {
    this.db.prepare(`INSERT OR REPLACE INTO spec_meta (key, value) VALUES (?, ?)`).run(key, value);
  }

  getMeta(key: string): string | undefined {
    const row = this.db.prepare(`SELECT value FROM spec_meta WHERE key = ?`).get(key) as Row | undefined;
    return row ? optionalText(row.value) : undefined;
  }

  optimize(): void {
    this.db.exec(`INSERT INTO specs_fts (specs_fts) VALUES ('optimize');`);
  }
}
