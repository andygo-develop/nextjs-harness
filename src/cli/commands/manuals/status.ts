/**
 * `nextjs-harness manuals status` — what is synced, what is indexed, is it current.
 */
import { access } from 'node:fs/promises';

import { readManualMeta } from '../../../rags/manuals/downloader.js';
import { ManualRepository } from '../../../rags/manuals/repository.js';
import { logger } from '../../../logger.js';
import { loadContext } from '../../context.js';

export interface StatusCommandOptions {
  cwd?: string;
  json?: boolean;
}

export interface ManualStatus {
  projectVersion: string;
  docsLine: string;
  lang: string;
  synced: boolean;
  syncedAt?: string;
  commit?: string;
  fileCount?: number;
  indexed: boolean;
  documentCount: number;
  indexedCommit?: string;
  indexCurrent: boolean;
  searchStrategy: 'bm25' | 'hybrid';
  /** Chunks with an embedding for the configured model — only meaningful for hybrid. */
  embeddedCount: number;
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

export async function collectStatus(options: StatusCommandOptions = {}): Promise<ManualStatus> {
  const { config, paths } = await loadContext(options.cwd);
  const docsLine = config.nextjs.docsLine;
  const lang = config.manuals.language;

  const meta = await readManualMeta(paths.manualMetaFile(docsLine));

  let documentCount = 0;
  let indexedCommit: string | undefined;
  let embeddedCount = 0;

  if (await exists(paths.indexFile)) {
    const repository = ManualRepository.open(paths.indexFile);
    try {
      documentCount = repository.countDocuments(docsLine, lang);
      indexedCommit = repository.getManualVersion(docsLine, lang)?.commit;
      if (config.index.searchStrategy === 'hybrid') {
        embeddedCount = repository.vectorCount(docsLine, lang, config.index.embeddingModel);
      }
    } finally {
      repository.close();
    }
  }

  return {
    projectVersion: config.nextjs.version,
    docsLine,
    lang,
    synced: Boolean(meta),
    syncedAt: meta?.syncedAt,
    commit: meta?.commit,
    fileCount: meta?.fileCount,
    indexed: documentCount > 0,
    documentCount,
    indexedCommit,
    indexCurrent: Boolean(meta && indexedCommit && meta.commit === indexedCommit && documentCount > 0),
    searchStrategy: config.index.searchStrategy,
    embeddedCount,
  };
}

export async function statusCommand(options: StatusCommandOptions = {}): Promise<void> {
  const status = await collectStatus(options);

  if (options.json) {
    logger.print(JSON.stringify(status, null, 2));
    return;
  }

  logger.print(`Next.js version:   ${status.projectVersion}`);
  logger.print(`Documentation:    nextjs-${status.docsLine} (${status.lang})`);
  logger.print();

  if (!status.synced) {
    logger.print('Manuals:          not synchronized');
    logger.print('Index:            empty');
    logger.print();
    logger.print('Run:');
    logger.print('  nextjs-harness manuals update');
    return;
  }

  logger.print(`Manuals:          ${status.fileCount} files, commit ${status.commit?.slice(0, 7)}`);
  logger.print(`Synced at:        ${status.syncedAt}`);
  logger.print(
    `Index:            ${status.indexed ? `${status.documentCount} documents` : 'empty'}` +
      (status.indexed ? ` (commit ${status.indexedCommit?.slice(0, 7) ?? 'unknown'})` : ''),
  );

  if (status.searchStrategy === 'hybrid') {
    const ready = status.embeddedCount >= status.documentCount && status.documentCount > 0;
    logger.print(
      `Search strategy:  hybrid — ${status.embeddedCount}/${status.documentCount} documents embedded` +
        (ready ? '' : ' (run manuals update to finish)'),
    );
  } else {
    logger.print('Search strategy:  bm25');
  }
  logger.print();

  if (status.indexCurrent) {
    logger.success('Index is current');
  } else {
    logger.warn('Index is out of date with the synchronized manuals');
    logger.print();
    logger.print('Run:');
    logger.print('  nextjs-harness manuals update');
  }
}
