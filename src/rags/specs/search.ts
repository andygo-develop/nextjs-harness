/**
 * BM25 search over the project spec index.
 *
 * Shares the manual searcher's FTS5 escaping and widening strategy, so a query
 * like `billing.service.ts` or `invoice()` behaves the same in both corpora.
 */
import { access } from 'node:fs/promises';
import path from 'node:path';

import { harnessPaths } from '../../cli/nextjs/project.js';
import { HarnessError, commandHint } from '../../errors.js';
import { embeddingsNotReadyError, fuseHybrid, hybridPoolSize } from '../embeddings/hybrid.js';
import type { EmbeddingProvider } from '../embeddings/provider.js';
import { createTransformersEmbeddingProvider } from '../embeddings/transformers-provider.js';
import {
  buildMatchExpression,
  buildPrefixExpression,
  tokenizeQuery,
  type LexicalStrategy,
} from '../manuals/search.js';
import { normalizeTags } from './discovery.js';
import { SpecRepository, type SpecHit } from './repository.js';

/** Location of the project spec index — separate from the manual index. */
export function specIndexFile(root: string): string {
  return path.join(harnessPaths(root).indexDir, 'specs.sqlite');
}

/** See DEFAULT_LIMIT in the manual searcher. */
const DEFAULT_LIMIT = 5;

export interface SpecSearchOutcome {
  hits: SpecHit[];
  strategy: LexicalStrategy | 'hybrid';
  /** See SearchOutcome.lexicalStrategy in the manual searcher. */
  lexicalStrategy?: LexicalStrategy;
  terms: string[];
}

export interface SearchSpecsOptions {
  repository: SpecRepository;
  query: string;
  limit?: number;
  /** See SearchOptions.strategy in the manual searcher. */
  strategy?: 'bm25' | 'hybrid';
  embeddings?: EmbeddingProvider;
  /**
   * Keep only specs carrying at least one of these tags (from `specs.include`).
   * Matched case-insensitively; omitted or empty means no filtering.
   */
  tags?: readonly string[];
}

function bm25Candidates(
  repository: SpecRepository,
  terms: readonly string[],
  limit: number,
  tags: readonly string[],
): { hits: SpecHit[]; strategy: LexicalStrategy } {
  const run = (expression: string): SpecHit[] => repository.search(expression, limit, tags);

  const all = run(buildMatchExpression(terms, 'AND'));
  if (all.length > 0) {
    return { hits: all, strategy: 'all-terms' };
  }

  if (terms.length > 1) {
    const any = run(buildMatchExpression(terms, 'OR'));
    if (any.length > 0) {
      return { hits: any, strategy: 'any-term' };
    }
  }

  const prefix = run(buildPrefixExpression(terms));
  return { hits: prefix, strategy: prefix.length > 0 ? 'prefix' : 'none' };
}

/** See hybridSearch in the manual searcher — same fusion, specs' own repository. */
async function hybridSearch(
  options: SearchSpecsOptions,
  terms: readonly string[],
  limit: number,
  tags: readonly string[],
): Promise<SpecSearchOutcome> {
  const embeddings = options.embeddings;
  if (!embeddings) {
    throw new HarnessError('Hybrid search requires an embeddings provider.', {
      hint: 'This is an internal error — searchSpecs was called with strategy "hybrid" but no embeddings.',
    });
  }

  const lexical = bm25Candidates(options.repository, terms, hybridPoolSize(limit), tags);

  // Both rankers are filtered, so a fused hit can never be an untagged spec.
  const hits = await fuseHybrid({
    corpus: {
      listVectors: (model) => options.repository.listVectors(model, tags),
      get: (id) => options.repository.get(id),
    },
    embeddings,
    query: options.query,
    limit,
    lexicalHits: lexical.hits,
  });

  return {
    hits,
    strategy: hits.length > 0 ? 'hybrid' : 'none',
    lexicalStrategy: lexical.strategy,
    terms: [...terms],
  };
}

export async function searchSpecs(options: SearchSpecsOptions): Promise<SpecSearchOutcome> {
  const terms = tokenizeQuery(options.query);
  const limit = options.limit ?? DEFAULT_LIMIT;
  const tags = normalizeTags(options.tags ?? []);

  if (terms.length === 0) {
    return { hits: [], strategy: 'none', terms };
  }

  if (options.strategy === 'hybrid') {
    return hybridSearch(options, terms, limit, tags);
  }

  const { hits, strategy } = bm25Candidates(options.repository, terms, limit, tags);
  return { hits, strategy, terms };
}

/**
 * How the spec corpus should be searched.
 *
 * A discriminated union rather than two independent optional fields, because
 * `embeddingModel` is genuinely required under `hybrid`. Expressed as two
 * optionals, a caller could omit it and get an error naming a default model
 * they never chose, while the corpus was embedded with a different one.
 */
export type SpecCorpusStrategy =
  | { searchStrategy?: 'bm25'; embeddingModel?: never }
  | { searchStrategy: 'hybrid'; embeddingModel: string };

export type OpenSpecCorpusOptions = {
  root: string;
  enabled: boolean;
} & SpecCorpusStrategy;

export interface ResolvedSpecCorpus {
  repository: SpecRepository;
  documentCount: number;
  searchStrategy: 'bm25' | 'hybrid';
  /** See ResolvedCorpus.requireEmbeddings in the manual corpus — same contract. */
  requireEmbeddings(): EmbeddingProvider | undefined;
  close(): void;
}

/**
 * Opens the spec index, or explains how to create it.
 *
 * Spec indexing is opt-in, so "not enabled" and "enabled but empty" are
 * different situations and get different guidance.
 */
export async function openSpecCorpus(options: OpenSpecCorpusOptions): Promise<ResolvedSpecCorpus> {
  const indexFile = specIndexFile(options.root);

  let exists = true;
  try {
    await access(indexFile);
  } catch {
    exists = false;
  }

  if (!exists) {
    throw new HarnessError(
      options.enabled
        ? 'The project spec index has not been built yet.'
        : 'Project spec search is not enabled for this project.',
      { hint: commandHint('nextjs-harness specs index') },
    );
  }

  const repository = SpecRepository.open(indexFile);
  const documentCount = repository.count();

  if (documentCount === 0) {
    repository.close();
    throw new HarnessError('The project spec index is empty — no matching files were found.', {
      hint:
        'Check the include patterns in .nextjs-harness/config.json, then run:\n\n' +
        '  nextjs-harness specs index',
    });
  }

  const requireEmbeddingsFor = (model: string) => (): EmbeddingProvider => {
    const embedded = repository.vectorCount(model);
    if (embedded < documentCount) {
      throw embeddingsNotReadyError({
        what: 'the project spec index',
        model,
        embedded,
        total: documentCount,
        command: 'nextjs-harness specs index',
      });
    }
    return createTransformersEmbeddingProvider(model);
  };

  return {
    repository,
    documentCount,
    searchStrategy: options.searchStrategy ?? 'bm25',
    requireEmbeddings:
      options.searchStrategy === 'hybrid'
        ? requireEmbeddingsFor(options.embeddingModel)
        : () => undefined,
    close: () => repository.close(),
  };
}
