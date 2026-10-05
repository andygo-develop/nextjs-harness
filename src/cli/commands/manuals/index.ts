/**
 * `nextjs-harness manuals index` — build the search index from synced files.
 *
 * (This file backs the `index` subcommand; it is not a barrel export.)
 */
import { createTransformersEmbeddingProvider } from '../../../rags/embeddings/transformers-provider.js';
import { readManualMeta } from '../../../rags/manuals/downloader.js';
import { indexManuals, type IndexResult } from '../../../rags/manuals/indexer.js';
import { ManualRepository } from '../../../rags/manuals/repository.js';
import { logger } from '../../../logger.js';
import { loadContext } from '../../context.js';

export interface IndexCommandOptions {
  cwd?: string;
  /** Discard the existing corpus and rebuild it from scratch. */
  rebuild?: boolean;
}

export async function runIndex(options: IndexCommandOptions = {}): Promise<IndexResult> {
  const { config, paths } = await loadContext(options.cwd);
  const docsLine = config.nextjs.docsLine;
  const lang = config.manuals.language;

  const meta = await readManualMeta(paths.manualMetaFile(docsLine));
  const repository = ManualRepository.open(paths.indexFile);

  try {
    if (options.rebuild) {
      repository.deleteCorpus(docsLine, lang);
    }

    const embeddings =
      config.index.searchStrategy === 'hybrid'
        ? createTransformersEmbeddingProvider(config.index.embeddingModel)
        : undefined;

    return await indexManuals({
      repository,
      manualDir: paths.manualDir(docsLine),
      docsLine,
      lang,
      commit: meta?.commit,
      source: meta?.source,
      syncedAt: meta?.syncedAt,
      embeddings,
    });
  } finally {
    repository.close();
  }
}

export function reportIndexResult(result: IndexResult): void {
  const documentsChanged = result.added + result.updated + result.removed;

  // "Nothing to do" has to mean nothing at all. Embedding work with no document
  // changes is the normal shape of switching an existing corpus to hybrid, and
  // of resuming an interrupted embedding run — reporting those as a no-op is
  // how a half-embedded index used to look finished.
  if (documentsChanged === 0 && result.embedded === 0) {
    logger.success(`Index already current — ${result.total} documents, nothing to do`);
    return;
  }

  if (documentsChanged > 0) {
    logger.success(
      `Indexed ${result.total} documents from ${result.files} files ` +
        `(+${result.added} new, ~${result.updated} changed, -${result.removed} removed) in ${result.durationMs}ms`,
    );
  } else {
    logger.success(`Index already current — ${result.total} documents`);
  }

  if (result.embedded > 0) {
    logger.success(`Computed embeddings for ${result.embedded} chunks (hybrid search)`);
  }
}

export async function indexCommand(options: IndexCommandOptions = {}): Promise<void> {
  reportIndexResult(await runIndex(options));
}
