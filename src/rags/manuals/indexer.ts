/**
 * Builds the searchable index from synchronised Markdown.
 *
 * Indexing is incremental by content hash: a chunk whose hash is unchanged is
 * left alone, so re-running `manuals index` after an unchanged sync touches
 * nothing and reports zero work.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { HarnessError, commandHint } from '../../errors.js';
import { logger } from '../../logger.js';
import { createEmbeddingWriter } from '../embeddings/indexing.js';
import type { EmbeddingProvider } from '../embeddings/provider.js';
import { parseFrontMatter, splitFrontMatter } from './normalizer.js';
import { docsRoute, parsePage, type ParsedChunk } from './parser.js';
import type { ManualRepository } from './repository.js';

/**
 * Files that exist only to drive the docs repository itself. They contain no
 * documentation worth searching and would pollute results.
 */
const SKIPPED_FILES = new Set(['README.md', 'CONTRIBUTING.md']);

export interface IndexResult {
  docsLine: string;
  lang: string;
  files: number;
  added: number;
  updated: number;
  removed: number;
  unchanged: number;
  total: number;
  /** Chunks embedded this run — 0 unless `embeddings` was passed in. */
  embedded: number;
  durationMs: number;
}

/** Recursively lists Markdown and MDX files, relative to `root`, in a stable order. */
export async function listMarkdownFiles(root: string, prefix = ''): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(path.join(root, prefix), { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      files.push(...(await listMarkdownFiles(root, relative)));
    } else if (entry.isFile() && /\.mdx?$/.test(entry.name) && !SKIPPED_FILES.has(entry.name)) {
      files.push(relative);
    }
  }

  return files;
}

export interface IndexOptions {
  repository: ManualRepository;
  manualDir: string;
  docsLine: string;
  lang: string;
  commit?: string;
  source?: string;
  syncedAt?: string;
  /**
   * When given, computes and stores an embedding for every chunk that changed
   * *or* does not yet have a vector for this model — what
   * `index.searchStrategy: "hybrid"` needs to actually search against, and what
   * lets an already-indexed corpus be upgraded to hybrid in place. Omitted
   * entirely for the default `bm25` strategy, so indexing stays exactly as fast
   * and as offline as it always was.
   */
  embeddings?: EmbeddingProvider;
}

export async function indexManuals(options: IndexOptions): Promise<IndexResult> {
  const startedAt = Date.now();
  const files = await listMarkdownFiles(options.manualDir);

  if (files.length === 0) {
    throw new HarnessError(
      `No Next.js ${options.docsLine} documentation found to index (language: ${options.lang}).`,
      { hint: commandHint('nextjs-harness manuals sync') },
    );
  }

  const existing = options.repository.hashesFor(options.docsLine, options.lang);
  const seen = new Set<string>();
  const updatedAt = new Date().toISOString();

  /**
   * A chunk needs embedding when its text changed *or* when it simply has no
   * vector for this model yet.
   *
   * That second half is not an optimisation, it is the whole feature: on a
   * corpus that was indexed under `bm25`, every hash already matches, so a
   * hash-only test would embed nothing and hybrid search could never be
   * switched on. It is also what makes an interrupted run resumable — whatever
   * was already written is skipped, whatever was not is picked up.
   */
  const alreadyEmbedded = options.embeddings
    ? options.repository.idsWithVectors(options.docsLine, options.lang, options.embeddings.model)
    : new Set<string>();

  const writer = options.embeddings
    ? createEmbeddingWriter(options.repository, options.embeddings)
    : undefined;

  let added = 0;
  let updated = 0;
  let unchanged = 0;

  // Pages Router pages often share an App Router page's content via
  // `source: app/…` front matter; this resolves that route back to a file.
  const fileByRoute = new Map(files.map((file) => [docsRoute(file), file]));

  for (const file of files) {
    const source = await readFile(path.join(options.manualDir, file), 'utf8');
    const sharedRoute = parseFrontMatter(splitFrontMatter(source).frontMatter).source?.replace(/^\/?(docs\/)?/, '');
    const sharedFile = sharedRoute ? fileByRoute.get(sharedRoute) : undefined;
    const sharedSource =
      sharedFile && sharedFile !== file ? await readFile(path.join(options.manualDir, sharedFile), 'utf8') : undefined;

    const chunks = parsePage({
      docsLine: options.docsLine,
      lang: options.lang,
      path: file,
      source,
      ...(sharedSource !== undefined ? { sharedSource } : {}),
    });

    // Collected inside the transaction but embedded after it commits: embedding
    // is async, and an open SQLite transaction must not span an await.
    const toEmbed: ParsedChunk[] = [];

    options.repository.transaction(() => {
      for (const chunk of chunks) {
        seen.add(chunk.id);
        const previous = existing.get(chunk.id);

        if (previous === undefined) {
          options.repository.insert(chunk, updatedAt);
          added += 1;
        } else if (previous !== chunk.hash) {
          options.repository.update(chunk, updatedAt);
          updated += 1;
        } else {
          unchanged += 1;
        }

        if (writer && (previous !== chunk.hash || !alreadyEmbedded.has(chunk.id))) {
          toEmbed.push(chunk);
        }
      }
    });

    // Embedded a file at a time rather than after the whole corpus is parsed,
    // so peak memory is one batch instead of every chunk's full text, and an
    // interrupted run has durably stored everything up to the last batch.
    for (const chunk of toEmbed) {
      await writer!.add(chunk);
    }
  }

  await writer?.flush();

  const removedIds = [...existing.keys()].filter((id) => !seen.has(id));
  if (removedIds.length > 0) {
    options.repository.transaction(() => {
      options.repository.deleteByIds(removedIds);
    });
  }

  const total = options.repository.countDocuments(options.docsLine, options.lang);

  options.repository.recordManualVersion({
    docsLine: options.docsLine,
    lang: options.lang,
    commit: options.commit,
    source: options.source,
    syncedAt: options.syncedAt,
    indexedAt: updatedAt,
    documentCount: total,
  });

  if (added + updated + removedIds.length > 0) {
    options.repository.optimize();
  }

  const result: IndexResult = {
    docsLine: options.docsLine,
    lang: options.lang,
    files: files.length,
    added,
    updated,
    removed: removedIds.length,
    unchanged,
    total,
    embedded: writer?.written ?? 0,
    durationMs: Date.now() - startedAt,
  };

  logger.debug(
    `Indexed ${result.files} files: +${result.added} ~${result.updated} -${result.removed} =${result.unchanged}`,
  );

  return result;
}
