/**
 * `nextjs-harness manuals search <query>` — human-readable BM25 search.
 */
import { openCorpus } from '../../../rags/manuals/corpus.js';
import { toExcerpt } from '../../../rags/manuals/normalizer.js';
import { searchManuals, type SearchOutcome } from '../../../rags/manuals/search.js';
import { logger } from '../../../logger.js';
import { loadContext } from '../../context.js';

export interface SearchCommandOptions {
  cwd?: string;
  limit?: number;
  full?: boolean;
  version?: string;
}

export async function runSearch(
  query: string,
  options: SearchCommandOptions = {},
): Promise<SearchOutcome & { projectVersion: string; docsLine: string }> {
  const { config, project } = await loadContext(options.cwd);
  const corpus = await openCorpus({
    root: project.root,
    config,
    versionOverride: options.version,
  });

  try {
    const outcome = await searchManuals({
      repository: corpus.repository,
      docsLine: corpus.docsLine,
      lang: corpus.lang,
      query,
      limit: options.limit ?? 5,
      strategy: corpus.searchStrategy,
      embeddings: corpus.requireEmbeddings(),
    });

    return { ...outcome, projectVersion: corpus.projectVersion, docsLine: corpus.docsLine };
  } finally {
    corpus.close();
  }
}

export async function searchCommand(query: string, options: SearchCommandOptions = {}): Promise<void> {
  const outcome = await runSearch(query, options);

  if (outcome.hits.length === 0) {
    logger.warn(`No results for "${query}" in Next.js ${outcome.docsLine} documentation.`);
    logger.print();
    logger.print('Try fewer or more general terms, for example:');
    logger.print('  nextjs-harness manuals search "middleware"');
    return;
  }

  // Under hybrid, which bm25 pass fed the pool is the part worth knowing — see
  // SearchOutcome.lexicalStrategy.
  const strategy = outcome.lexicalStrategy
    ? `${outcome.strategy} (lexical: ${outcome.lexicalStrategy})`
    : outcome.strategy;
  logger.debug(`Matched using strategy: ${strategy} (terms: ${outcome.terms.join(', ')})`);
  logger.print();

  for (const [position, hit] of outcome.hits.entries()) {
    const heading = hit.heading && hit.heading !== hit.title ? `${hit.title} › ${hit.heading}` : hit.title;

    logger.print(`${position + 1}. ${heading}`);
    logger.print(`   Section: ${hit.section}`);
    logger.print(`   Version: ${outcome.docsLine} (project: ${outcome.projectVersion})`);
    logger.print(`   URL: ${hit.url}`);
    logger.print(`   Id:  ${hit.id}`);
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
