/**
 * `nextjs-harness specs status` — is project spec search enabled and current?
 */
import { access } from 'node:fs/promises';

import { logger } from '../../../logger.js';
import type { SpecIncludeEntry } from '../../../generators/config-generator/schema.js';
import { discoverSpecFiles, includePattern, includeTags } from '../../../rags/specs/discovery.js';
import { SpecRepository } from '../../../rags/specs/repository.js';
import { specIndexFile } from '../../../rags/specs/search.js';
import { loadContext } from '../../context.js';

export interface SpecsStatusOptions {
  cwd?: string;
  json?: boolean;
}

export interface SpecsStatus {
  enabled: boolean;
  include: SpecIncludeEntry[];
  exclude: string[];
  indexed: boolean;
  documentCount: number;
  indexedFileCount: number;
  /** Files currently matching the patterns on disk. */
  matchingFiles: number;
  indexedAt?: string;
}

export async function collectSpecsStatus(options: SpecsStatusOptions = {}): Promise<SpecsStatus> {
  const { config, project } = await loadContext(options.cwd);
  const indexFile = specIndexFile(project.root);

  const { files } = await discoverSpecFiles({
    root: project.root,
    include: config.specs.include,
    exclude: config.specs.exclude,
  });

  let documentCount = 0;
  let indexedFileCount = 0;
  let indexedAt: string | undefined;
  let indexed = false;

  try {
    await access(indexFile);
    const repository = SpecRepository.open(indexFile);
    try {
      documentCount = repository.count();
      indexedFileCount = repository.countFiles();
      indexedAt = repository.getMeta('indexed_at');
      indexed = documentCount > 0;
    } finally {
      repository.close();
    }
  } catch {
    indexed = false;
  }

  return {
    enabled: config.specs.enabled,
    include: [...config.specs.include],
    exclude: [...config.specs.exclude],
    indexed,
    documentCount,
    indexedFileCount,
    matchingFiles: files.length,
    ...(indexedAt ? { indexedAt } : {}),
  };
}

/** `docs/**\/*.md [docs, adr]` for a tagged entry, the bare glob otherwise. */
function describeInclude(entry: SpecIncludeEntry): string {
  const tags = includeTags(entry);
  return tags.length > 0 ? `${includePattern(entry)} [${tags.join(', ')}]` : includePattern(entry);
}

export async function specsStatusCommand(options: SpecsStatusOptions = {}): Promise<void> {
  const status = await collectSpecsStatus(options);

  if (options.json) {
    logger.print(JSON.stringify(status, null, 2));
    return;
  }

  logger.print(`Project specs:    ${status.enabled ? 'enabled' : 'not enabled'}`);
  logger.print(`Include:          ${status.include.map(describeInclude).join(', ')}`);
  logger.print(`Matching files:   ${status.matchingFiles}`);
  logger.print(
    `Index:            ${status.indexed ? `${status.documentCount} documents from ${status.indexedFileCount} files` : 'empty'}`,
  );

  if (status.indexedAt) {
    logger.print(`Indexed at:       ${status.indexedAt}`);
  }

  logger.print();

  if (!status.enabled || !status.indexed) {
    logger.print('Run:');
    logger.print('  nextjs-harness specs index');
  } else if (status.matchingFiles !== status.indexedFileCount) {
    logger.warn('Files on disk differ from what is indexed');
    logger.print();
    logger.print('Run:');
    logger.print('  nextjs-harness specs index');
  } else {
    logger.success('Project spec index is current');
  }
}
