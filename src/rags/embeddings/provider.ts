/**
 * The embedding contract hybrid search is built on, plus the pure-math and
 * storage helpers every implementation and consumer shares.
 *
 * Kept deliberately small: one method, batched. The real implementation
 * (`transformers-provider.ts`) wraps a local WASM/ONNX model; tests use a
 * cheap deterministic fake instead, since embedding computation must never
 * touch the network in the test suite (see `tests/helpers.ts`).
 */
export interface EmbeddingProvider {
  /** Identifies the model, so a vector can be traced back to what produced it. */
  readonly model: string;
  /** One vector per input text, in the same order. */
  embed(texts: readonly string[]): Promise<Float32Array[]>;
}

/**
 * Cosine similarity, robust to vectors that are not pre-normalised.
 *
 * Real embedding models typically return unit vectors already (dot product
 * would suffice), but this stays correct regardless of what a given
 * `EmbeddingProvider` — including a test fake — actually returns.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  // Vectors of different widths are not comparable, and reading past the end of
  // the shorter one would yield NaN. That matters more than it looks: `sort`
  // leaves NaN comparisons unordered, so a single mismatched vector could sit
  // at rank 1. Callers that care about *why* a vector is unusable should filter
  // on length first — see `fuseHybrid`.
  if (a.length !== b.length) {
    return 0;
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i += 1) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }

  if (normA === 0 || normB === 0) {
    return 0;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** Serialises a vector for storage as a SQLite BLOB. */
export function serializeVector(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

/**
 * Reads a vector back from a SQLite BLOB.
 *
 * Copies rather than viewing the driver's buffer directly: `node:sqlite` may
 * reuse or release the underlying memory after the row is read, and a
 * `Float32Array` view into it would then be reading undefined bytes.
 */
export function deserializeVector(blob: Uint8Array): Float32Array {
  const copy = Buffer.from(blob);
  return new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / Float32Array.BYTES_PER_ELEMENT);
}
