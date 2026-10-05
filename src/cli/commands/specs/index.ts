/**
 * `nextjs-harness specs index` — index the project's own specs and docs.
 *
 * Running this is what opts the project in: it flips `specs.enabled` in the
 * config, so the MCP tools and `specs search` start working. Nothing scans the
 * repository until the developer asks for it.
 */
import { logger } from '../../../logger.js';
import { createTransformersEmbeddingProvider } from '../../../rags/embeddings/transformers-provider.js';
import { indexSpecs, type SpecIndexResult } from '../../../rags/specs/indexer.js';
import { SpecRepository } from '../../../rags/specs/repository.js';
import { specIndexFile } from '../../../rags/specs/search.js';
import { updateConfig } from '../../../generators/config-generator/config.js';
import { loadContext } from '../../context.js';

export interface SpecsIndexOptions {
  cwd?: string;
  /** Discard the existing spec corpus and rebuild from scratch. */
  rebuild?: boolean;
}

export async function runSpecsIndex(options: SpecsIndexOptions = {}): Promise<SpecIndexResult> {
  const { config, project } = await loadContext(options.cwd);
  const repository = SpecRepository.open(specIndexFile(project.root));

  try {
    if (options.rebuild) {
      repository.deleteByIds([...repository.hashes().keys()]);
    }

    const embeddings =
      config.index.searchStrategy === 'hybrid'
        ? createTransformersEmbeddingProvider(config.index.embeddingModel)
        : undefined;

    const result = await indexSpecs({
      repository,
      root: project.root,
      include: config.specs.include,
      exclude: config.specs.exclude,
      embeddings,
    });

    if (!config.specs.enabled) {
      await updateConfig(project.root, (current) => ({
        ...current,
        specs: { ...current.specs, enabled: true },
      }));
    }

    return result;
  } finally {
    repository.close();
  }
}

export function reportSpecsIndex(result: SpecIndexResult): void {
  if (result.files === 0) {
    logger.warn('No project spec files matched the configured patterns');
    logger.print();
    logger.print('Adjust "specs.include" in .nextjs-harness/config.json, for example:');
    logger.print('  "include": ["docs/**/*.md", "specs/**/*.md", "*.md"]');
    return;
  }

  // See reportIndexResult in the manual indexer for why `embedded` counts here.
  if (result.added + result.updated + result.removed === 0) {
    logger.success(
      `Spec index already current — ${result.total} documents from ${result.files} files` +
        (result.embedded > 0 ? '' : ', nothing to do'),
    );
  } else {
    logger.success(
      `Indexed ${result.total} spec documents from ${result.files} files ` +
        `(+${result.added} new, ~${result.updated} changed, -${result.removed} removed) in ${result.durationMs}ms`,
    );
  }

  if (result.truncated) {
    logger.warn('Discovery stopped at the file limit — narrow "specs.include" to index the rest.');
  }

  if (result.embedded > 0) {
    logger.success(`Computed embeddings for ${result.embedded} chunks (hybrid search)`);
  }
}

export async function specsIndexCommand(options: SpecsIndexOptions = {}): Promise<void> {
  reportSpecsIndex(await runSpecsIndex(options));
}
