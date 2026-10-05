/**
 * Reciprocal rank fusion — combining a lexical ranking and a semantic ranking
 * into one, without needing their scores to be on comparable scales.
 *
 * BM25 scores and cosine similarities are not commensurable: a BM25 score of
 * -8 and a cosine similarity of 0.8 cannot be weighted-summed meaningfully.
 * RRF sidesteps that entirely by using only *rank position*, which is why it
 * is the standard, low-parameter way to blend heterogeneous rankers.
 */

/** Standard smoothing constant from the original RRF paper (Cormack et al.). */
const RRF_K = 60;

/**
 * Scores every id that appears in at least one ranking by
 * `sum(1 / (k + rank))` across the rankings it appears in — higher is better.
 * An id absent from a ranking simply contributes nothing from that ranking.
 */
export function reciprocalRankFusion(rankings: ReadonlyArray<readonly string[]>): Map<string, number> {
  const scores = new Map<string, number>();

  for (const ranking of rankings) {
    ranking.forEach((id, index) => {
      const contribution = 1 / (RRF_K + index + 1);
      scores.set(id, (scores.get(id) ?? 0) + contribution);
    });
  }

  return scores;
}

/** Ids from a score map, ranked best-first. */
export function rankByScore(scores: ReadonlyMap<string, number>): string[] {
  return [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}
