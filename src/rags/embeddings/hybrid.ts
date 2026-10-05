/**
 * The corpus-agnostic half of hybrid search.
 *
 * Manuals and specs are separate corpora with separate indexes — a separation
 * this package deliberately enforces — but *blending* a lexical ranking with a
 * semantic one is the same operation either way. It lives here so a fix to the
 * pool size, the dimension guard or the snippet fallback lands once instead of
 * being applied twice and drifting.
 *
 * What stays corpus-specific: the FTS5 widening cascade, which speaks each
 * repository's own query shape.
 */
import { HarnessError, commandHint } from '../../errors.js';
import { cosineSimilarity, type EmbeddingProvider } from './provider.js';
import { rankByScore, reciprocalRankFusion } from './rrf.js';

/**
 * The error both corpora raise when hybrid search is configured but the index
 * is not fully embedded.
 *
 * Deliberately count-based rather than "does a single vector exist": an
 * interrupted embedding run leaves a handful of vectors behind, and ranking
 * against 4% of a corpus is a silent quality collapse — precisely what
 * refusing to run hybrid search at all is meant to prevent.
 */
export function embeddingsNotReadyError(options: {
  /** What is not embedded, named for the user, e.g. "nextjs-v16.3.8". */
  what: string;
  model: string;
  embedded: number;
  total: number;
  /** The command that finishes the job. */
  command: string;
}): HarnessError {
  const progress =
    options.embedded === 0
      ? 'no documents have embeddings yet'
      : `only ${options.embedded} of ${options.total} documents have embeddings`;

  return new HarnessError(
    `This project is configured for hybrid search, but ${options.what} has not been fully ` +
      `indexed with embeddings for model "${options.model}" — ${progress}.`,
    { hint: commandHint(options.command) },
  );
}

/**
 * How many candidates each ranker contributes to the fusion pool, before the
 * caller's `limit` is applied. Wider than a typical `limit` so RRF has more
 * than one page of results to actually rank between — fusing two 5-result
 * lists would just be interleaving them.
 */
const MIN_HYBRID_POOL_SIZE = 30;

/**
 * The pool each ranker is asked for. Never smaller than the caller's `limit`:
 * a `--limit 100` must not come back with 30 results just because the strategy
 * is hybrid.
 */
export function hybridPoolSize(limit: number): number {
  return Math.max(MIN_HYBRID_POOL_SIZE, limit);
}

/** The minimum a stored document must look like to be fused and returned. */
export interface HybridDocument {
  id: string;
  content: string;
}

/** The two repository operations fusion needs, in either corpus's dialect. */
export interface HybridCorpus<TDocument extends HybridDocument> {
  listVectors(model: string): Array<{ id: string; vector: Float32Array }>;
  get(id: string): TDocument | undefined;
}

export interface FuseHybridOptions<TDocument extends HybridDocument> {
  corpus: HybridCorpus<TDocument>;
  embeddings: EmbeddingProvider;
  query: string;
  limit: number;
  /** The bm25 pass's hits, best-first, already at `hybridPoolSize(limit)`. */
  lexicalHits: ReadonlyArray<{ id: string; snippet: string }>;
}

/**
 * Blends a lexical candidate pool with semantic similarity via reciprocal rank
 * fusion. A chunk relevant in *either* ranking, and especially one relevant in
 * both, outranks a chunk only one ranker liked.
 */
export async function fuseHybrid<TDocument extends HybridDocument>(
  options: FuseHybridOptions<TDocument>,
): Promise<Array<TDocument & { score: number; snippet: string }>> {
  const poolSize = hybridPoolSize(options.limit);
  const lexicalIds = options.lexicalHits.map((hit) => hit.id);

  const vectors = options.corpus.listVectors(options.embeddings.model);
  let semanticIds: string[] = [];

  if (vectors.length > 0) {
    const [queryVector] = await options.embeddings.embed([options.query]);
    const width = queryVector!.length;

    // A stored vector of a different width cannot be compared with this query's
    // (a model upgrade that changed output width, or an `embeddingModel` name
    // reused across two different models). Dropping them silently would rank
    // against a shrunken corpus, so if *nothing* is comparable, say so.
    const usable = vectors.filter((entry) => entry.vector.length === width);

    if (usable.length === 0) {
      throw new HarnessError(
        `Stored embeddings for model "${options.embeddings.model}" have a different number of ` +
          `dimensions (${vectors[0]!.vector.length}) than the model now produces (${width}).`,
        {
          hint:
            'The model behind this name has changed. Rebuild the index so the stored vectors match:\n\n' +
            '  nextjs-harness manuals index --rebuild\n' +
            '  nextjs-harness specs index --rebuild',
        },
      );
    }

    semanticIds = usable
      .map(({ id, vector }) => ({ id, similarity: cosineSimilarity(queryVector!, vector) }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, poolSize)
      .map((entry) => entry.id);
  }

  const fusedScores = reciprocalRankFusion([lexicalIds, semanticIds]);
  const fused = rankByScore(fusedScores).slice(0, options.limit);

  // Reuse the bm25 pass's snippet where there is one; a vector-only hit has no
  // FTS match to snippet, so it falls back to its raw content and callers never
  // have to special-case an empty excerpt.
  const snippetById = new Map(options.lexicalHits.map((hit) => [hit.id, hit.snippet]));

  return fused
    .map((id) => options.corpus.get(id))
    .filter((document): document is TDocument => document !== undefined)
    .map((document) => ({
      ...document,
      // Note the inverted convention from bm25: here higher is better, not lower.
      score: fusedScores.get(document.id) ?? 0,
      snippet: snippetById.get(document.id) || document.content,
    }));
}
