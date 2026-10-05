/**
 * `nextjs-harness manuals sync` — download the official manuals.
 *
 * Low-level on purpose: it syncs and stops. `manuals update` is the command
 * developers normally want.
 */
import { syncManuals, type SyncResult } from '../../../rags/manuals/downloader.js';
import { logger } from '../../../logger.js';
import { loadContext } from '../../context.js';

export interface SyncCommandOptions {
  force?: boolean;
  cwd?: string;
}

export async function runSync(options: SyncCommandOptions = {}): Promise<SyncResult> {
  const { config, paths } = await loadContext(options.cwd);
  const docsLine = config.nextjs.docsLine;
  const lang = config.manuals.language;

  logger.info(`Synchronizing Next.js ${config.nextjs.version} documentation (nextjs-${docsLine})…`);

  return syncManuals({
    docsLine,
    lang,
    version: config.nextjs.version,
    repository: config.manuals.repository,
    manualDir: paths.manualDir(docsLine),
    metaFile: paths.manualMetaFile(docsLine),
    cacheDir: paths.cacheDir,
    force: options.force,
  });
}

export async function syncCommand(options: SyncCommandOptions = {}): Promise<void> {
  const result = await runSync(options);

  if (result.changed) {
    logger.success(
      `Synchronized ${result.fileCount} documentation files (commit ${result.commit.slice(0, 7)})`,
    );
    logger.print();
    logger.print('Next:');
    logger.print('  nextjs-harness manuals index');
  } else {
    logger.success(`Already up to date (commit ${result.commit.slice(0, 7)})`);
  }
}
