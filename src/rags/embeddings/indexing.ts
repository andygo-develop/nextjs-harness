/**
 * The corpus-agnostic half of embedding *at index time*.
 *
 * Both indexers face the same two problems — how much to hold in memory before
 * embedding starts, and how often to commit — so both get the same answer here
 * rather than each growing its own copy.
 *
 * The writer is deliberately streaming: chunks are handed over as they are
 * parsed and flushed a batch at a time, so peak memory is one batch rather than
 * the whole corpus, and an interrupted run leaves every completed batch durably
 * stored. Resuming is then just a matter of embedding what has no vector yet —
 * see `chunksNeedingEmbedding` in each indexer.
 */
import type { EmbeddingProvider } from './provider.js';

/** Texts are embedded in small batches so one huge in-flight call never blocks. */
export const EMBED_BATCH_SIZE = 16;

/** The shape both `ParsedChunk` and `SpecChunk` already satisfy. */
export interface EmbeddableChunk {
  id: string;
  title: string;
  heading?: string;
  content: string;
}

/** The two repository operations the writer needs, in either corpus's dialect. */
export interface VectorStore {
  upsertVector(id: string, model: string, vector: Float32Array): void;
  transaction<T>(work: () => T): T;
}

/** Text handed to the embedding model: heading context plus body. */
export function embeddingText(chunk: EmbeddableChunk): string {
  return [chunk.title, chunk.heading, chunk.content].filter(Boolean).join('\n\n');
}

export interface EmbeddingWriter {
  /** Queues a chunk, embedding and committing once a full batch has built up. */
  add(chunk: EmbeddableChunk): Promise<void>;
  /** Embeds and commits whatever is still queued. Call once at the end. */
  flush(): Promise<void>;
  /** How many chunks have actually been embedded and stored so far. */
  readonly written: number;
}

export function createEmbeddingWriter(
  store: VectorStore,
  embeddings: EmbeddingProvider,
): EmbeddingWriter {
  const pending: EmbeddableChunk[] = [];
  let written = 0;

  const writeBatch = async (batch: readonly EmbeddableChunk[]): Promise<void> => {
    const vectors = await embeddings.embed(batch.map(embeddingText));

    // One commit per batch, not one per chunk. Document writes are already
    // batched per file; leaving vector writes unbatched would mean a separate
    // WAL commit and fsync for every chunk in the corpus.
    store.transaction(() => {
      batch.forEach((chunk, index) => {
        store.upsertVector(chunk.id, embeddings.model, vectors[index]!);
      });
    });

    written += batch.length;
  };

  return {
    get written(): number {
      return written;
    },
    async add(chunk: EmbeddableChunk): Promise<void> {
      pending.push(chunk);
      if (pending.length >= EMBED_BATCH_SIZE) {
        await writeBatch(pending.splice(0, EMBED_BATCH_SIZE));
      }
    },
    async flush(): Promise<void> {
      while (pending.length > 0) {
        await writeBatch(pending.splice(0, EMBED_BATCH_SIZE));
      }
    },
  };
}
