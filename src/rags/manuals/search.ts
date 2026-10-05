/**
 * BM25 search over the documentation index.
 *
 * The interesting problem here is that raw developer queries are not valid
 * FTS5 syntax. `"use client"`, `revalidateTag()`, `next.config.ts` and
 * `useRouter?` all contain characters FTS5 treats as operators or simply
 * rejects, so a naive `MATCH ?` throws a syntax error on exactly the queries
 * developers type most.
 *
 * We therefore tokenise the query ourselves and re-emit it as quoted terms,
 * then widen the search in stages until something matches.
 */
import { HarnessError } from '../../errors.js';
import { fuseHybrid, hybridPoolSize } from '../embeddings/hybrid.js';
import type { EmbeddingProvider } from '../embeddings/provider.js';
import type { ManualRepository, SearchHit } from './repository.js';

/** Result count when the caller does not ask for one. */
const DEFAULT_LIMIT = 5;

export interface SearchOptions {
  repository: ManualRepository;
  docsLine: string;
  lang: string;
  query: string;
  limit?: number;
  /**
   * `bm25` (default) — lexical only, exactly as before.
   * `hybrid` — blends bm25 with semantic similarity via reciprocal rank
   * fusion. Requires `embeddings`; see `openCorpus`, which resolves this from
   * `index.searchStrategy`, and its `requireEmbeddings()`, which is what
   * validates the corpus was actually indexed for it.
   */
  strategy?: 'bm25' | 'hybrid';
  embeddings?: EmbeddingProvider;
}

/** Quotes a term for FTS5, doubling any embedded quotes. */
function quote(term: string): string {
  return `"${term.replace(/"/g, '""')}"`;
}

/**
 * Splits a query into FTS5-safe terms.
 *
 * Double-quoted runs are preserved as phrases; everything else is split on
 * non-alphanumeric characters, which naturally turns `user.service.ts` into
 * three terms and `findOne()` into one.
 */
export function tokenizeQuery(query: string): string[] {
  const terms: string[] = [];
  const phrasePattern = /"([^"]+)"/g;

  let remainder = query;
  for (const match of query.matchAll(phrasePattern)) {
    const phrase = match[1]!.trim();
    if (phrase) {
      terms.push(phrase.replace(/[^\p{L}\p{N}_ ]+/gu, ' ').replace(/\s+/g, ' ').trim());
    }
    remainder = remainder.replace(match[0], ' ');
  }

  for (const token of remainder.split(/[^\p{L}\p{N}_]+/u)) {
    if (token) {
      terms.push(token);
    }
  }

  return terms.filter(Boolean);
}

/** Builds an FTS5 MATCH expression joining terms with the given operator. */
export function buildMatchExpression(terms: readonly string[], operator: 'AND' | 'OR' = 'AND'): string {
  return terms.map(quote).join(` ${operator} `);
}

/**
 * Prefix variant, used as the last widening step: `middlew*` matches middleware.
 *
 * The trailing `*` is only appended after a word character — FTS5 rejects it
 * otherwise, which is why both corpora share this rather than each writing
 * their own.
 */
export function buildPrefixExpression(terms: readonly string[]): string {
  return terms.map((term) => (/[\p{L}\p{N}_]$/u.test(term) ? `${quote(term)} *` : quote(term))).join(' OR ');
}

/** Which widening pass of the bm25 cascade produced a result set. */
export type LexicalStrategy = 'all-terms' | 'any-term' | 'prefix' | 'none';

export interface SearchOutcome {
  hits: SearchHit[];
  /** Which pass produced the hits — useful with --verbose. */
  strategy: LexicalStrategy | 'hybrid';
  /**
   * Under `hybrid`, which bm25 pass fed the fusion pool.
   *
   * Reporting only "hybrid" would lose the diagnostic `--verbose` exists for:
   * a pool built from `all-terms` is a strong lexical match, while one built
   * from `prefix` means the lexical half was already a last resort.
   */
  lexicalStrategy?: LexicalStrategy;
  terms: string[];
}

/** The bm25 widening cascade alone, at an arbitrary pool size. */
function bm25Candidates(
  repository: ManualRepository,
  docsLine: string,
  lang: string,
  terms: readonly string[],
  limit: number,
): { hits: SearchHit[]; strategy: LexicalStrategy } {
  const run = (matchExpression: string): SearchHit[] =>
    repository.search({ matchExpression, docsLine, lang, limit });

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

/**
 * Blends the bm25 candidate pool with semantic similarity via reciprocal
 * rank fusion — see `fuseHybrid`, which both corpora share.
 */
async function hybridSearch(
  options: SearchOptions,
  terms: readonly string[],
  limit: number,
): Promise<SearchOutcome> {
  const embeddings = options.embeddings;
  if (!embeddings) {
    throw new HarnessError('Hybrid search requires an embeddings provider.', {
      hint: 'This is an internal error — searchManuals was called with strategy "hybrid" but no embeddings.',
    });
  }

  const lexical = bm25Candidates(
    options.repository,
    options.docsLine,
    options.lang,
    terms,
    hybridPoolSize(limit),
  );

  const hits = await fuseHybrid({
    corpus: {
      listVectors: (model) => options.repository.listVectors(options.docsLine, options.lang, model),
      get: (id) => options.repository.getDocument(id),
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

/**
 * Searches one corpus. Callers must have resolved the corpus already —
 * see `openCorpus`, which is what enforces version safety.
 */
export async function searchManuals(options: SearchOptions): Promise<SearchOutcome> {
  const terms = tokenizeQuery(options.query);
  const limit = options.limit ?? DEFAULT_LIMIT;

  if (terms.length === 0) {
    return { hits: [], strategy: 'none', terms };
  }

  if (options.strategy === 'hybrid') {
    return hybridSearch(options, terms, limit);
  }

  const { hits, strategy } = bm25Candidates(options.repository, options.docsLine, options.lang, terms, limit);
  return { hits, strategy, terms };
}
