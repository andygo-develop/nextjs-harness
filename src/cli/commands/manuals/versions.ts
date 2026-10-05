/**
 * `nextjs-harness manuals versions` — which documentation lines exist and
 * which are present locally.
 *
 * Offline by design: this reads local state only, so it stays instant and
 * works without a network.
 */
import { access } from 'node:fs/promises';

import { docsLineForMajor, SUPPORTED_MAJORS } from '../../nextjs/version.js';
import { readManualMeta } from '../../../rags/manuals/downloader.js';
import { ManualRepository } from '../../../rags/manuals/repository.js';
import { logger } from '../../../logger.js';
import { loadContext } from '../../context.js';

export interface VersionsCommandOptions {
  cwd?: string;
}

export interface VersionRow {
  docsLine: string;
  isProject: boolean;
  synced: boolean;
  documentCount: number;
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

export async function collectVersions(options: VersionsCommandOptions = {}): Promise<VersionRow[]> {
  const { config, paths } = await loadContext(options.cwd);
  const lang = config.manuals.language;

  let counts = new Map<string, number>();
  if (await exists(paths.indexFile)) {
    const repository = ManualRepository.open(paths.indexFile);
    try {
      counts = new Map(
        repository
          .listManualVersions()
          .filter((row) => row.lang === lang)
          .map((row) => [row.docsLine, row.documentCount]),
      );
    } finally {
      repository.close();
    }
  }

  // The project's own line always appears, even when it is not one of the
  // pinned majors: a project on a Next.js newer than this release knows about
  // is served `canary` (see version.ts), and leaving it out would print a
  // table in which nothing is marked as the line actually in use.
  const lines = [...new Set([...SUPPORTED_MAJORS.map(docsLineForMajor), config.nextjs.docsLine])];

  const rows: VersionRow[] = [];
  for (const docsLine of lines) {
    const meta = await readManualMeta(paths.manualMetaFile(docsLine));

    rows.push({
      docsLine,
      isProject: docsLine === config.nextjs.docsLine,
      synced: Boolean(meta),
      documentCount: counts.get(docsLine) ?? 0,
    });
  }

  return rows;
}

export async function versionsCommand(options: VersionsCommandOptions = {}): Promise<void> {
  const rows = await collectVersions(options);

  logger.print('Next.js documentation lines');
  logger.print();
  logger.print(`  ${'LINE'.padEnd(16)}${'PROJECT'.padEnd(9)}${'SYNCED'.padEnd(8)}INDEXED`);

  for (const row of rows) {
    const line = `nextjs-${row.docsLine}`.padEnd(16);
    const project = (row.isProject ? 'yes' : '-').padEnd(9);
    const synced = (row.synced ? 'yes' : '-').padEnd(8);
    const indexed = row.documentCount > 0 ? String(row.documentCount) : '-';
    logger.print(`  ${line}${project}${synced}${indexed}`);
  }

  logger.print();
  logger.print('Only the line matching your project is used for search.');
}
