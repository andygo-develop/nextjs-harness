/**
 * The real `EmbeddingProvider`: a local sentence-embedding model run via
 * `@huggingface/transformers` (transformers.js), the WASM/ONNX successor to
 * Xenova's transformers.js.
 *
 * This is imported dynamically, and only from call sites that already know
 * `index.searchStrategy` is `hybrid` — the default `bm25` strategy never
 * loads this module, never downloads a model, and never touches the network.
 * That keeps the package's default footprint exactly what it was before
 * hybrid search existed.
 *
 * Caveat worth knowing: in Node, transformers.js runs its ONNX graph through
 * `onnxruntime-node`, which ships a small prebuilt (not compiled) native
 * addon per platform. Opting into hybrid search is therefore the one path in
 * this package that is not "no native modules" — the default bm25 path is
 * unaffected. This provider is also not covered by the offline test suite for
 * that reason (it needs a real model download on first use); the hybrid
 * blending logic itself (RRF, cosine similarity, storage) is tested against a
 * deterministic fake provider instead — see `tests/helpers.ts`.
 */
import { HarnessError } from '../../errors.js';
import { logger } from '../../logger.js';
import type { EmbeddingProvider } from './provider.js';

/** A `Tensor`-shaped result, matching what transformers.js returns. */
interface EmbeddingTensor {
  tolist(): number[][];
}

interface FeatureExtractionPipeline {
  (texts: string[], options: { pooling: 'mean'; normalize: true }): Promise<EmbeddingTensor>;
}

// One pipeline per model, lazily created and reused for the life of the
// process — loading a model is the expensive part, embedding calls are not.
const pipelines = new Map<string, Promise<FeatureExtractionPipeline>>();

/** The shape transformers.js reports loading progress in. */
interface ProgressEvent {
  status?: string;
  file?: string;
  progress?: number;
}

/**
 * Reports a cold model download as it happens.
 *
 * On a machine that has never used this model, loading it means fetching tens
 * of megabytes — and it is triggered lazily by the *first search*, which may be
 * a single MCP tool call. Without this, that call simply blocks for minutes
 * with no output, indistinguishable from a hung server. A warm cache emits no
 * progress events and so stays silent.
 *
 * `logger` writes to stderr under `mcp start`, so none of this can corrupt the
 * JSON-RPC stream on stdout.
 */
function createProgressReporter(model: string): (event: ProgressEvent) => void {
  let announced = false;
  const reported = new Set<string>();

  return (event: ProgressEvent): void => {
    if (event.status !== 'progress' || !event.file) {
      return;
    }

    if (!announced) {
      announced = true;
      logger.info(
        `Downloading the embedding model "${model}" for hybrid search — ` +
          'this happens once, then it is cached locally.',
      );
    }

    // Quarter-steps per file: enough to show it is moving, few enough that a
    // multi-file download does not scroll the terminal.
    const percent = Math.floor((event.progress ?? 0) / 25) * 25;
    const key = `${event.file}:${percent}`;
    if (percent > 0 && !reported.has(key)) {
      reported.add(key);
      logger.info(`  ${event.file}: ${percent}%`);
    }
  };
}

async function loadPipeline(model: string): Promise<FeatureExtractionPipeline> {
  let cached = pipelines.get(model);
  if (!cached) {
    cached = (async () => {
      try {
        const { pipeline } = await import('@huggingface/transformers');
        logger.debug(`Loading embedding model "${model}"…`);
        const extractor = await pipeline('feature-extraction', model, {
          progress_callback: createProgressReporter(model),
        });
        logger.debug(`Embedding model "${model}" is ready.`);
        return extractor as unknown as FeatureExtractionPipeline;
      } catch (cause) {
        // Not a HarnessError-worthy "bug" — most likely no network on first
        // use (the model downloads and caches on demand) or a bad model id.
        throw new HarnessError(`Could not load the hybrid search embedding model "${model}".`, {
          hint:
            'This model downloads on first use, so it needs a network connection once.\n\n' +
            'Check your connection and try again, or switch back to lexical-only search:\n\n' +
            '  set "index.searchStrategy" to "bm25" in .nextjs-harness/config.json',
          cause,
        });
      }
    })();
    // A failed load must not be cached — the next call should retry rather
    // than replaying the same rejection forever (e.g. after network returns).
    cached.catch(() => pipelines.delete(model));
    pipelines.set(model, cached);
  }
  return cached;
}

/**
 * Texts are capped before embedding. `all-MiniLM-L6-v2`'s effective context is
 * ~256 tokens; the tokenizer truncates safely on its own, but capping here
 * avoids handing it pathologically large chunks for no benefit.
 */
const MAX_EMBED_CHARS = 2000;

export function createTransformersEmbeddingProvider(model: string): EmbeddingProvider {
  return {
    model,
    async embed(texts: readonly string[]): Promise<Float32Array[]> {
      const extractor = await loadPipeline(model);
      const truncated = texts.map((text) => text.slice(0, MAX_EMBED_CHARS));
      const output = await extractor(truncated, { pooling: 'mean', normalize: true });
      return output.tolist().map((row) => Float32Array.from(row));
    },
  };
}
