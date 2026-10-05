/**
 * Indexes the project's own spec/documentation files.
 *
 * Incremental by content hash, exactly like the manual indexer: an unchanged
 * re-run touches nothing, and files removed from the project are pruned.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { logger } from '../../logger.js';
import { createEmbeddingWriter } from '../embeddings/indexing.js';
import type { EmbeddingProvider } from '../embeddings/provider.js';
import { discoverSpecFiles } from './discovery.js';
import { parseSpec, type SpecChunk } from './parser.js';
import type { SpecRepository } from './repository.js';

export interface SpecIndexResult {
  files: number;
  added: number;
  updated: number;
  removed: number;
  unchanged: number;
  total: number;
  /** Chunks embedded this run — 0 unless `embeddings` was passed in. */
  embedded: number;
  truncated: boolean;
  durationMs: number;
}

export interface IndexSpecsOptions {
  repository: SpecRepository;
  root: string;
  include: readonly string[];
  exclude: readonly string[];
  limit?: number;
  /** See `IndexOptions.embeddings` in the manual indexer. */
  embeddings?: EmbeddingProvider;
}

export async function indexSpecs(options: IndexSpecsOptions): Promise<SpecIndexResult> {
  const startedAt = Date.now();

  const { files, truncated } = await discoverSpecFiles({
    root: options.root,
    include: options.include,
    exclude: options.exclude,
    ...(options.limit === undefined ? {} : { limit: options.limit }),
  });

  const existing = options.repository.hashes();
  const seen = new Set<string>();
  const updatedAt = new Date().toISOString();

  /** See `alreadyEmbedded` in the manual indexer — same reasoning, specs' corpus. */
  const alreadyEmbedded = options.embeddings
    ? options.repository.idsWithVectors(options.embeddings.model)
    : new Set<string>();

  const writer = options.embeddings
    ? createEmbeddingWriter(options.repository, options.embeddings)
    : undefined;

  let added = 0;
  let updated = 0;
  let unchanged = 0;

  for (const file of files) {
    let source: string;
    try {
      source = await readFile(path.join(options.root, file), 'utf8');
    } catch {
      continue;
    }

    const chunks = parseSpec({ path: file, source });
    const toEmbed: SpecChunk[] = [];

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

  if (added + updated + removedIds.length > 0) {
    options.repository.optimize();
  }

  options.repository.setMeta('indexed_at', updatedAt);
  options.repository.setMeta('file_count', String(files.length));

  const result: SpecIndexResult = {
    files: files.length,
    added,
    updated,
    removed: removedIds.length,
    unchanged,
    total: options.repository.count(),
    embedded: writer?.written ?? 0,
    truncated,
    durationMs: Date.now() - startedAt,
  };

  logger.debug(
    `Indexed ${result.files} spec files: +${result.added} ~${result.updated} -${result.removed} =${result.unchanged}`,
  );

  return result;
}
