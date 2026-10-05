/**
 * `nextjs-harness manuals update` — the everyday command: sync, then index
 * only what actually changed.
 */
import type { HarnessConfig } from '../../../generators/config-generator/schema.js';
import { ManualRepository } from '../../../rags/manuals/repository.js';
import { logger } from '../../../logger.js';
import { loadContext } from '../../context.js';
import { runIndex, reportIndexResult } from './index.js';
import { runSync } from './sync.js';

export interface UpdateCommandOptions {
  cwd?: string;
  force?: boolean;
}

/**
 * Whether `update` has nothing left to do after a no-op sync.
 *
 * Split out (and exported) because the hybrid half is the subtle part and
 * deserves its own offline test: documents being current is *not* sufficient
 * under hybrid. A corpus indexed under bm25 and then switched to hybrid has
 * perfectly current documents and no vectors at all, and this is the very
 * command the "not fully indexed with embeddings" error sends people to — so
 * answering "everything is up to date" here is how that became a loop with no
 * way out.
 */
export function indexIsUpToDate(options: {
  repository: ManualRepository;
  config: HarnessConfig;
  syncCommit: string;
}): { current: boolean; documentCount: number } {
  const docsLine = options.config.nextjs.docsLine;
  const lang = options.config.manuals.language;

  const stored = options.repository.getManualVersion(docsLine, lang);
  const documentCount = options.repository.countDocuments(docsLine, lang);
  const documentsCurrent = Boolean(
    stored && stored.commit === options.syncCommit && documentCount > 0,
  );

  const embeddingsCurrent =
    options.config.index.searchStrategy !== 'hybrid' ||
    options.repository.vectorCount(docsLine, lang, options.config.index.embeddingModel) >=
      documentCount;

  return { current: documentsCurrent && embeddingsCurrent, documentCount };
}

export async function updateCommand(options: UpdateCommandOptions = {}): Promise<void> {
  const sync = await runSync({ cwd: options.cwd, force: options.force });

  if (sync.changed) {
    logger.success(`Synchronized ${sync.fileCount} files (commit ${sync.commit.slice(0, 7)})`);
  } else {
    logger.info(`Manuals already at commit ${sync.commit.slice(0, 7)}`);
  }

  // Even when the manuals did not change, the index may be missing or stale
  // (e.g. first run, or a previous run interrupted before indexing).
  if (!sync.changed && !options.force) {
    const { config, paths } = await loadContext(options.cwd);
    const repository = ManualRepository.open(paths.indexFile);

    try {
      const { current, documentCount } = indexIsUpToDate({
        repository,
        config,
        syncCommit: sync.commit,
      });

      if (current) {
        logger.success(`Everything is up to date — ${documentCount} documents indexed`);
        return;
      }
    } finally {
      repository.close();
    }
  }

  reportIndexResult(await runIndex({ cwd: options.cwd, rebuild: options.force }));
}
