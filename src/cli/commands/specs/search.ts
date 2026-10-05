/**
 * `nextjs-harness specs search <query>` — search the project's own specs.
 */
import { logger } from '../../../logger.js';
import { toExcerpt } from '../../../rags/manuals/normalizer.js';
import { openSpecCorpus, searchSpecs, type SpecSearchOutcome } from '../../../rags/specs/search.js';
import { loadContext } from '../../context.js';

export interface SpecsSearchOptions {
  cwd?: string;
  limit?: number;
  full?: boolean;
}

export async function runSpecsSearch(
  query: string,
  options: SpecsSearchOptions = {},
): Promise<SpecSearchOutcome> {
  const { config, project } = await loadContext(options.cwd);
  const corpus = await openSpecCorpus({
    root: project.root,
    enabled: config.specs.enabled,
    // Spelled out per branch because `embeddingModel` is only meaningful — and
    // only required — under "hybrid"; see SpecCorpusStrategy.
    ...(config.index.searchStrategy === 'hybrid'
      ? { searchStrategy: 'hybrid' as const, embeddingModel: config.index.embeddingModel }
      : { searchStrategy: 'bm25' as const }),
  });

  try {
    return await searchSpecs({
      repository: corpus.repository,
      query,
      limit: options.limit ?? 5,
      strategy: corpus.searchStrategy,
      embeddings: corpus.requireEmbeddings(),
    });
  } finally {
    corpus.close();
  }
}

export async function specsSearchCommand(
  query: string,
  options: SpecsSearchOptions = {},
): Promise<void> {
  const outcome = await runSpecsSearch(query, options);

  if (outcome.hits.length === 0) {
    logger.warn(`No project specs matched "${query}".`);
    return;
  }

  const strategy = outcome.lexicalStrategy
    ? `${outcome.strategy} (lexical: ${outcome.lexicalStrategy})`
    : outcome.strategy;
  logger.debug(`Matched using strategy: ${strategy} (terms: ${outcome.terms.join(', ')})`);
  logger.print();

  for (const [position, hit] of outcome.hits.entries()) {
    const heading = hit.heading && hit.heading !== hit.title ? `${hit.title} › ${hit.heading}` : hit.title;

    logger.print(`${position + 1}. ${heading}`);
    logger.print(`   Section: ${hit.section}`);
    logger.print(`   File: ${hit.path}${hit.anchor ? `#${hit.anchor}` : ''}`);
    logger.print(`   Id:   ${hit.id}`);
    logger.print();

    if (options.full) {
      for (const line of hit.content.split('\n')) {
        logger.print(`   ${line}`);
      }
    } else {
      logger.print(`   ${toExcerpt(hit.snippet || hit.content, 280)}`);
    }
    logger.print();
  }

  if (!options.full) {
    logger.print('Use --full to print whole documents, or --limit to change the result count.');
  }
}
