/**
 * Hybrid search: config, vector storage, indexing, RRF blending, and corpus
 * readiness — all offline, all against `makeFakeEmbeddingProvider` (a
 * deterministic, dependency-free stand-in — see `tests/helpers.ts`).
 *
 * What is deliberately *not* tested here: the real
 * `createTransformersEmbeddingProvider`. It needs a network-fetched model on
 * first use, which is out of scope for this offline suite; its own module has
 * the caveats documented on it.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { harnessPaths } from '../cli/nextjs/project.js';
import { indexIsUpToDate } from '../cli/commands/manuals/update.js';
import { loadConfig } from '../generators/config-generator/config.js';
import { configSchema, defaultConfig } from '../generators/config-generator/schema.js';
import {
  createEmbeddingWriter,
  EMBED_BATCH_SIZE,
  type VectorStore,
} from '../rags/embeddings/indexing.js';
import type { EmbeddingProvider } from '../rags/embeddings/provider.js';
import { cosineSimilarity, deserializeVector, serializeVector } from '../rags/embeddings/provider.js';
import { rankByScore, reciprocalRankFusion } from '../rags/embeddings/rrf.js';
import { openCorpus } from '../rags/manuals/corpus.js';
import { indexManuals } from '../rags/manuals/indexer.js';
import { ManualRepository } from '../rags/manuals/repository.js';
import { searchManuals } from '../rags/manuals/search.js';
import { indexSpecs } from '../rags/specs/indexer.js';
import { SpecRepository } from '../rags/specs/repository.js';
import { openSpecCorpus, searchSpecs, specIndexFile } from '../rags/specs/search.js';
import { cleanupTempDirs, fixtureCommit, makeFakeEmbeddingProvider, makeIndexedProject } from './helpers.js';

afterEach(cleanupTempDirs);

describe('embedding primitives', () => {
  it('is 1 for identical vectors', () => {
    const v = Float32Array.from([1, 2, 3]);
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 5);
  });

  it('is 0 for orthogonal vectors', () => {
    expect(cosineSimilarity(Float32Array.from([1, 0]), Float32Array.from([0, 1]))).toBeCloseTo(0, 5);
  });

  it('is -1 for opposite vectors', () => {
    expect(cosineSimilarity(Float32Array.from([1, 0]), Float32Array.from([-1, 0]))).toBeCloseTo(-1, 5);
  });

  it('is 0, not NaN, for a zero vector', () => {
    expect(cosineSimilarity(Float32Array.from([0, 0]), Float32Array.from([1, 1]))).toBe(0);
  });

  it('is 0, not NaN, when the vectors have different widths', () => {
    // NaN would be worse than useless here: `sort` leaves NaN comparisons
    // unordered, so a mismatched vector could end up ranked first.
    expect(cosineSimilarity(Float32Array.from([1, 0, 0, 0]), Float32Array.from([1, 0]))).toBe(0);
    expect(cosineSimilarity(Float32Array.from([1, 0]), Float32Array.from([1, 0, 0, 0]))).toBe(0);
  });

  it('round-trips a vector through blob serialization', () => {
    const original = Float32Array.from([0.5, -0.25, 1.75, 0]);
    const restored = deserializeVector(serializeVector(original));
    expect(Array.from(restored)).toEqual(Array.from(original));
  });
});

describe('reciprocal rank fusion', () => {
  it('scores an id present in both rankings above one present in only one', () => {
    const scores = reciprocalRankFusion([
      ['a', 'b', 'c'],
      ['b', 'a', 'd'],
    ]);
    expect(scores.get('a')!).toBeGreaterThan(scores.get('c')!);
    expect(scores.get('b')!).toBeGreaterThan(scores.get('d')!);
  });

  it('gives an earlier rank more weight than a later one', () => {
    const scores = reciprocalRankFusion([['first', 'second', 'third']]);
    expect(scores.get('first')!).toBeGreaterThan(scores.get('second')!);
    expect(scores.get('second')!).toBeGreaterThan(scores.get('third')!);
  });

  it('ranks best-first by score', () => {
    expect(rankByScore(reciprocalRankFusion([['x', 'y', 'z']]))).toEqual(['x', 'y', 'z']);
  });
});

describe('config schema', () => {
  it('defaults to bm25', () => {
    const config = defaultConfig({ version: '16.1', docsLine: 'v16.3.8' });
    expect(config.index.searchStrategy).toBe('bm25');
    expect(config.index.embeddingModel).toBeTruthy();
  });

  it('accepts hybrid', () => {
    const parsed = configSchema.parse({
      configVersion: 1,
      nextjs: { version: '16.1', docsLine: 'v16.3.8' },
      manuals: {},
      index: { searchStrategy: 'hybrid' },
      mcp: {},
    });
    expect(parsed.index.searchStrategy).toBe('hybrid');
  });

  it('rejects an unknown strategy rather than silently ignoring it', () => {
    expect(() =>
      configSchema.parse({
        configVersion: 1,
        nextjs: { version: '16.1', docsLine: 'v16.3.8' },
        manuals: {},
        index: { searchStrategy: 'vector-only' },
        mcp: {},
      }),
    ).toThrow();
  });
});

const manualChunk = {
  id: 'v16.3.8:en:01-app/03-api-reference/04-functions/revalidateTag.mdx#usage',
  docsLine: 'v16.3.8',
  lang: 'en',
  path: '01-app/03-api-reference/04-functions/revalidateTag.mdx',
  title: 'revalidateTag',
  heading: 'Usage',
  section: 'App Router › API Reference',
  url: 'https://nextjs.org/docs/app/api-reference/functions/revalidateTag#usage',
  content: 'revalidateTag can be called in Server Functions and Route Handlers.',
  hash: 'hash1',
};

describe('vector storage (manuals)', () => {
  it('round-trips a vector and reports readiness', () => {
    const repository = ManualRepository.openInMemory();
    try {
      repository.insert(manualChunk, new Date().toISOString());
      expect(repository.hasVectors('v16.3.8', 'en', 'test-model')).toBe(false);

      const vector = Float32Array.from([0.1, 0.2, 0.3]);
      repository.upsertVector(manualChunk.id, 'test-model', vector);

      expect(repository.hasVectors('v16.3.8', 'en', 'test-model')).toBe(true);
      expect(repository.vectorCount('v16.3.8', 'en', 'test-model')).toBe(1);

      const [stored] = repository.listVectors('v16.3.8', 'en', 'test-model');
      expect(stored!.id).toBe(manualChunk.id);
      expect(Array.from(stored!.vector)).toEqual(Array.from(vector));
    } finally {
      repository.close();
    }
  });

  it('removes vectors when the document is deleted', () => {
    const repository = ManualRepository.openInMemory();
    try {
      repository.insert(manualChunk, new Date().toISOString());
      repository.upsertVector(manualChunk.id, 'test-model', Float32Array.from([1, 2]));

      repository.deleteByIds([manualChunk.id]);

      expect(repository.hasVectors('v16.3.8', 'en', 'test-model')).toBe(false);
    } finally {
      repository.close();
    }
  });

  it('removes vectors when the whole corpus is deleted', () => {
    const repository = ManualRepository.openInMemory();
    try {
      repository.insert(manualChunk, new Date().toISOString());
      repository.upsertVector(manualChunk.id, 'test-model', Float32Array.from([1, 2]));

      repository.deleteCorpus('v16.3.8', 'en');

      expect(repository.hasVectors('v16.3.8', 'en', 'test-model')).toBe(false);
    } finally {
      repository.close();
    }
  });

  it('keeps vectors from different models independent', () => {
    const repository = ManualRepository.openInMemory();
    try {
      repository.insert(manualChunk, new Date().toISOString());
      repository.upsertVector(manualChunk.id, 'model-a', Float32Array.from([1, 0]));
      repository.upsertVector(manualChunk.id, 'model-b', Float32Array.from([0, 1]));

      expect(repository.vectorCount('v16.3.8', 'en', 'model-a')).toBe(1);
      expect(repository.vectorCount('v16.3.8', 'en', 'model-b')).toBe(1);
      expect(Array.from(repository.listVectors('v16.3.8', 'en', 'model-a')[0]!.vector)).not.toEqual(
        Array.from(repository.listVectors('v16.3.8', 'en', 'model-b')[0]!.vector),
      );
    } finally {
      repository.close();
    }
  });
});

const specChunk = {
  id: 'spec:docs/billing.md#rules',
  path: 'docs/billing.md',
  title: 'Billing',
  heading: 'Rules',
  section: 'docs',
  content: 'Invoice numbering rules.',
  hash: 'h1',
};

describe('vector storage (specs)', () => {
  it('round-trips a vector and reports readiness', () => {
    const repository = SpecRepository.openInMemory();
    try {
      repository.insert(specChunk, new Date().toISOString());
      expect(repository.hasVectors('test-model')).toBe(false);

      repository.upsertVector(specChunk.id, 'test-model', Float32Array.from([0.4, 0.6]));

      expect(repository.hasVectors('test-model')).toBe(true);
      const [stored] = repository.listVectors('test-model');
      expect(stored!.id).toBe(specChunk.id);
    } finally {
      repository.close();
    }
  });

  it('removes vectors when the document is deleted', () => {
    const repository = SpecRepository.openInMemory();
    try {
      repository.insert(specChunk, new Date().toISOString());
      repository.upsertVector(specChunk.id, 'test-model', Float32Array.from([1, 1]));

      repository.deleteByIds([specChunk.id]);

      expect(repository.hasVectors('test-model')).toBe(false);
    } finally {
      repository.close();
    }
  });
});

/** A corpus wide enough to span several embedding batches. */
function manyDocs(count: number): Record<string, string> {
  return Object.fromEntries(
    Array.from({ length: count }, (_, i) => [
      `01-app/02-guides/guide-${i}.mdx`,
      `---\ntitle: Guide ${i}\n---\n\nUnique body text for guide number ${i}.\n`,
    ]),
  );
}

describe('embedding writer', () => {
  it('commits one transaction per batch rather than one per chunk', async () => {
    const chunks = Array.from({ length: EMBED_BATCH_SIZE + 4 }, (_, i) => ({
      id: `c${i}`,
      title: `Title ${i}`,
      content: `Body ${i}`,
    }));

    let transactions = 0;
    const stored: string[] = [];
    const store: VectorStore = {
      transaction<T>(work: () => T): T {
        transactions += 1;
        return work();
      },
      upsertVector(id: string): void {
        stored.push(id);
      },
    };

    const batchSizes: number[] = [];
    const embeddings: EmbeddingProvider = {
      model: 'batch-test-model',
      async embed(texts: readonly string[]): Promise<Float32Array[]> {
        batchSizes.push(texts.length);
        return texts.map(() => Float32Array.from([1]));
      },
    };

    const writer = createEmbeddingWriter(store, embeddings);
    for (const chunk of chunks) {
      await writer.add(chunk);
    }
    await writer.flush();

    // Full batch flushed as soon as it filled, remainder on flush() — which is
    // also what bounds peak memory to one batch rather than the whole corpus.
    expect(batchSizes).toEqual([EMBED_BATCH_SIZE, 4]);
    expect(transactions).toBe(2);
    expect(stored).toHaveLength(chunks.length);
    expect(writer.written).toBe(chunks.length);
  });
});

describe('indexing with an embedding provider', () => {
  it('embeds every chunk and reports the count', async () => {
    const { root } = await makeIndexedProject({
      constraint: '^16.1.0',
      embeddings: makeFakeEmbeddingProvider(),
    });
    const paths = harnessPaths(root);
    const repository = ManualRepository.open(paths.indexFile);
    try {
      const total = repository.countDocuments('v16.3.8', 'en');
      expect(total).toBeGreaterThan(0);
      expect(repository.vectorCount('v16.3.8', 'en', 'fake-test-model')).toBe(total);
    } finally {
      repository.close();
    }
  });

  it('embeds nothing for the default bm25 strategy', async () => {
    const { root } = await makeIndexedProject({ constraint: '^16.1.0' });
    const repository = ManualRepository.open(harnessPaths(root).indexFile);
    try {
      expect(repository.hasVectors('v16.3.8', 'en', 'fake-test-model')).toBe(false);
    } finally {
      repository.close();
    }
  });

  it('only re-embeds chunks that actually changed on a reindex', async () => {
    const { root } = await makeIndexedProject({
      constraint: '^16.1.0',
      embeddings: makeFakeEmbeddingProvider(),
    });
    const paths = harnessPaths(root);
    const repository = ManualRepository.open(paths.indexFile);
    try {
      const result = await indexManuals({
        repository,
        manualDir: paths.manualDir('v16.3.8'),
        docsLine: 'v16.3.8',
        lang: 'en',
        embeddings: makeFakeEmbeddingProvider(),
      });
      expect(result.added + result.updated).toBe(0);
      expect(result.embedded).toBe(0);
    } finally {
      repository.close();
    }
  });

  it('embeds an existing bm25 corpus when hybrid is switched on, though no hash changed', async () => {
    // The upgrade path: a corpus indexed under bm25, then `searchStrategy`
    // flipped to hybrid. Every content hash still matches, so deciding what to
    // embed from hashes alone would embed nothing — forever.
    const { root } = await makeIndexedProject({ constraint: '^16.1.0' });
    const paths = harnessPaths(root);
    const repository = ManualRepository.open(paths.indexFile);

    try {
      const total = repository.countDocuments('v16.3.8', 'en');
      expect(repository.vectorCount('v16.3.8', 'en', 'fake-test-model')).toBe(0);

      const result = await indexManuals({
        repository,
        manualDir: paths.manualDir('v16.3.8'),
        docsLine: 'v16.3.8',
        lang: 'en',
        embeddings: makeFakeEmbeddingProvider(),
      });

      expect(result.added + result.updated + result.removed).toBe(0);
      expect(result.embedded).toBe(total);
      expect(repository.vectorCount('v16.3.8', 'en', 'fake-test-model')).toBe(total);
    } finally {
      repository.close();
    }
  });

  it('resumes an interrupted embedding run instead of leaving the corpus half embedded', async () => {
    const { root } = await makeIndexedProject({ constraint: '^16.1.0', docs: manyDocs(40) });
    const paths = harnessPaths(root);
    const repository = ManualRepository.open(paths.indexFile);

    try {
      const total = repository.countDocuments('v16.3.8', 'en');
      const working = makeFakeEmbeddingProvider('resumable-model');

      // Fails after the first batch — the shape of losing the network partway
      // through the on-demand model download.
      let calls = 0;
      const flaky: EmbeddingProvider = {
        model: working.model,
        async embed(texts: readonly string[]): Promise<Float32Array[]> {
          calls += 1;
          if (calls > 1) {
            throw new Error('network gone');
          }
          return working.embed(texts);
        },
      };

      const index = (embeddings: EmbeddingProvider) =>
        indexManuals({
          repository,
          manualDir: paths.manualDir('v16.3.8'),
          docsLine: 'v16.3.8',
          lang: 'en',
          embeddings,
        });

      await expect(index(flaky)).rejects.toThrow('network gone');

      // Whatever completed is durable, so the rerun has less to do, not more.
      const partial = repository.vectorCount('v16.3.8', 'en', working.model);
      expect(partial).toBeGreaterThan(0);
      expect(partial).toBeLessThan(total);

      const result = await index(working);
      expect(result.embedded).toBe(total - partial);
      expect(repository.vectorCount('v16.3.8', 'en', working.model)).toBe(total);
    } finally {
      repository.close();
    }
  });
});

/** A provider with full manual control over what each exact text embeds to. */
function fixedVectorProvider(vectors: Record<string, number[]>, model = 'fixed-test-model'): EmbeddingProvider {
  return {
    model,
    async embed(texts: readonly string[]): Promise<Float32Array[]> {
      return texts.map((text) => Float32Array.from(vectors[text] ?? [0, 0]));
    },
  };
}

function insertManual(repository: ManualRepository, id: string, title: string, content: string): void {
  repository.insert(
    {
      id,
      docsLine: 'v16.3.8',
      lang: 'en',
      path: `01-app/02-guides/${id}.mdx`,
      title,
      section: 'App Router',
      url: `https://nextjs.org/docs/app/guides/${id}`,
      content,
      hash: id,
    },
    new Date().toISOString(),
  );
}

describe('hybrid search blending', () => {
  it('throws when strategy is hybrid but no embeddings are given', async () => {
    const repository = ManualRepository.openInMemory();
    try {
      await expect(
        searchManuals({ repository, docsLine: 'v16.3.8', lang: 'en', query: 'middleware', strategy: 'hybrid' }),
      ).rejects.toThrow(/embeddings provider/);
    } finally {
      repository.close();
    }
  });

  it('degrades to the bm25 ranking when no vectors have been indexed yet', async () => {
    const repository = ManualRepository.openInMemory();
    try {
      insertManual(repository, 'a', 'Middleware', 'Middleware runs before a request is completed.');

      const outcome = await searchManuals({
        repository,
        docsLine: 'v16.3.8',
        lang: 'en',
        query: 'middleware',
        strategy: 'hybrid',
        embeddings: makeFakeEmbeddingProvider(),
      });

      expect(outcome.strategy).toBe('hybrid');
      expect(outcome.hits.map((hit) => hit.id)).toEqual(['a']);
    } finally {
      repository.close();
    }
  });

  it('surfaces a document bm25 alone would never return, because it has no shared terms', async () => {
    const repository = ManualRepository.openInMemory();
    const query = 'rewrites';
    // The query's embedding, under our full control; document vectors are set
    // directly below rather than derived from it, for a fully deterministic scenario.
    const embeddings = fixedVectorProvider({ [query]: [0, 1] });

    try {
      // Contains "rewrites" — bm25 alone will find this.
      insertManual(repository, 'bm25-match', 'rewrites', 'Rewrites map an incoming request path to a different destination path.');
      // Shares no term with the query at all — bm25 alone will never find this.
      insertManual(repository, 'vector-match', 'Proxy', 'Proxy runs code before a request is completed, with no mention of the query term.');

      // Orthogonal to the query vector, so cosine similarity is 0 for one and 1 for the other.
      repository.upsertVector('bm25-match', embeddings.model, Float32Array.from([1, 0]));
      repository.upsertVector('vector-match', embeddings.model, Float32Array.from([0, 1]));

      // Confirm the premise: plain bm25 finds the lexical match but never the other one.
      const bm25Only = await searchManuals({ repository, docsLine: 'v16.3.8', lang: 'en', query });
      expect(bm25Only.hits.map((hit) => hit.id)).toEqual(['bm25-match']);

      const hybrid = await searchManuals({
        repository,
        docsLine: 'v16.3.8',
        lang: 'en',
        query,
        strategy: 'hybrid',
        embeddings,
      });

      expect(hybrid.hits.map((hit) => hit.id)).toContain('vector-match');

      // A vector-only hit has no FTS match and so no snippet. The documented
      // contract is that it falls back to its own content, not to an empty
      // string that every caller then has to work around.
      const vectorOnly = hybrid.hits.find((hit) => hit.id === 'vector-match')!;
      expect(vectorOnly.snippet).toBe(vectorOnly.content);
      expect(vectorOnly.snippet).not.toBe('');
    } finally {
      repository.close();
    }
  });

  it('reports which bm25 pass fed the pool, instead of only "hybrid"', async () => {
    const repository = ManualRepository.openInMemory();
    try {
      insertManual(repository, 'a', 'Middleware', 'Middleware runs before a request is completed.');

      const outcome = await searchManuals({
        repository,
        docsLine: 'v16.3.8',
        lang: 'en',
        query: 'middleware',
        strategy: 'hybrid',
        embeddings: makeFakeEmbeddingProvider(),
      });

      expect(outcome.strategy).toBe('hybrid');
      // Without this, --verbose cannot tell a strong lexical match from a
      // desperate prefix fallback.
      expect(outcome.lexicalStrategy).toBe('all-terms');
    } finally {
      repository.close();
    }
  });

  it('returns as many results as asked for, even past the fusion pool size', async () => {
    const repository = ManualRepository.openInMemory();
    const embeddings = makeFakeEmbeddingProvider();
    const count = 40; // wider than the 30-candidate pool each ranker contributes

    try {
      const contents = Array.from({ length: count }, (_, i) => `Middleware topic number ${i}.`);
      contents.forEach((content, i) => {
        insertManual(repository, `doc-${i}`, `Middleware ${i}`, content);
      });

      const vectors = await embeddings.embed(contents);
      vectors.forEach((vector, i) => repository.upsertVector(`doc-${i}`, embeddings.model, vector));

      const outcome = await searchManuals({
        repository,
        docsLine: 'v16.3.8',
        lang: 'en',
        query: 'middleware',
        strategy: 'hybrid',
        embeddings,
        limit: count,
      });

      // A --limit above the pool size used to be silently truncated to ~30.
      expect(outcome.hits).toHaveLength(count);
    } finally {
      repository.close();
    }
  });

  it('reports a dimension mismatch rather than ranking against nothing', async () => {
    const repository = ManualRepository.openInMemory();
    // The query embeds to 2 dims; the stored vector is 4 — what a model that
    // changed output width under the same name would leave behind.
    const embeddings = fixedVectorProvider({ rewrites: [0, 1] });

    try {
      insertManual(repository, 'a', 'rewrites', 'Rewrites map a request path to another path.');
      repository.upsertVector('a', embeddings.model, Float32Array.from([1, 0, 0, 0]));

      await expect(
        searchManuals({
          repository,
          docsLine: 'v16.3.8',
          lang: 'en',
          query: 'rewrites',
          strategy: 'hybrid',
          embeddings,
        }),
      ).rejects.toThrow(/different number of dimensions/);
    } finally {
      repository.close();
    }
  });

  it('ranks a document relevant in both rankings above one relevant in only one', async () => {
    const repository = ManualRepository.openInMemory();
    // A single term, so bm25's all-terms pass is a plain match rather than an
    // AND across multiple terms — which would short-circuit before any
    // partial match (like 'lexical-only' below) could enter the pool.
    const query = 'middleware';
    const embeddings = fixedVectorProvider({ [query]: [0, 1] });

    try {
      insertManual(repository, 'both', 'Middleware Matcher', 'Middleware runs on every request its matcher selects.');
      insertManual(repository, 'lexical-only', 'Upgrading', 'A brief unrelated mention of middleware.');
      insertManual(repository, 'semantic-only', 'Proxy', 'Nothing to do with the query in words at all.');

      // 'both' matches the query vector exactly; 'lexical-only' is orthogonal
      // (bm25 relevance only); 'semantic-only' also matches the query vector
      // exactly (vector relevance only, since it shares no term with the query).
      repository.upsertVector('both', embeddings.model, Float32Array.from([0, 1]));
      repository.upsertVector('lexical-only', embeddings.model, Float32Array.from([1, 0]));
      repository.upsertVector('semantic-only', embeddings.model, Float32Array.from([0, 1]));

      const outcome = await searchManuals({
        repository,
        docsLine: 'v16.3.8',
        lang: 'en',
        query,
        strategy: 'hybrid',
        embeddings,
        limit: 3,
      });

      expect(outcome.hits[0]!.id).toBe('both');
      expect(outcome.hits.map((hit) => hit.id)).toEqual(
        expect.arrayContaining(['lexical-only', 'semantic-only']),
      );
    } finally {
      repository.close();
    }
  });
});

describe('manuals update short-circuit', () => {
  const configFor = async (root: string, searchStrategy: 'bm25' | 'hybrid', embeddingModel: string) => {
    const config = (await loadConfig(root))!;
    return { ...config, index: { ...config.index, searchStrategy, embeddingModel } };
  };

  it('reports an unembedded corpus as up to date under bm25', async () => {
    const { root } = await makeIndexedProject({ constraint: '^16.1.0' });
    const repository = ManualRepository.open(harnessPaths(root).indexFile);
    try {
      const config = await configFor(root, 'bm25', 'any-model');
      expect(indexIsUpToDate({ repository, config, syncCommit: fixtureCommit('v16.3.8') }).current).toBe(true);
    } finally {
      repository.close();
    }
  });

  it('does not report an unembedded corpus as up to date under hybrid', async () => {
    // Otherwise `manuals update` prints "Everything is up to date" and returns
    // without indexing — while the error that sent the user here says to run
    // exactly this command.
    const { root } = await makeIndexedProject({ constraint: '^16.1.0' });
    const repository = ManualRepository.open(harnessPaths(root).indexFile);
    try {
      const config = await configFor(root, 'hybrid', 'not-yet-indexed-model');
      expect(indexIsUpToDate({ repository, config, syncCommit: fixtureCommit('v16.3.8') }).current).toBe(false);
    } finally {
      repository.close();
    }
  });

  it('reports up to date under hybrid once every document is embedded', async () => {
    const { root } = await makeIndexedProject({
      constraint: '^16.1.0',
      embeddings: makeFakeEmbeddingProvider('done-model'),
    });
    const repository = ManualRepository.open(harnessPaths(root).indexFile);
    try {
      const config = await configFor(root, 'hybrid', 'done-model');
      expect(indexIsUpToDate({ repository, config, syncCommit: fixtureCommit('v16.3.8') }).current).toBe(true);
    } finally {
      repository.close();
    }
  });
});

describe('corpus readiness for hybrid search', () => {
  /** The project config, with hybrid forced on for the given model. */
  const hybridConfigFor = async (root: string, embeddingModel: string) => {
    const config = (await loadConfig(root))!;
    return { ...config, index: { ...config.index, searchStrategy: 'hybrid' as const, embeddingModel } };
  };

  it('resolves searchStrategy "bm25" with no embeddings by default', async () => {
    const { root } = await makeIndexedProject({ constraint: '^16.1.0' });
    const config = (await loadConfig(root))!;
    const corpus = await openCorpus({ root, config });
    try {
      expect(corpus.searchStrategy).toBe('bm25');
      expect(corpus.requireEmbeddings()).toBeUndefined();
    } finally {
      corpus.close();
    }
  });

  it('refuses hybrid search on a corpus that has not been embedded for the configured model', async () => {
    const { root } = await makeIndexedProject({ constraint: '^16.1.0' });
    const config = await hybridConfigFor(root, 'never-indexed-model');

    const corpus = await openCorpus({ root, config });
    try {
      expect(() => corpus.requireEmbeddings()).toThrow(/not been fully indexed with embeddings/);
    } finally {
      corpus.close();
    }
  });

  it('still opens the corpus under hybrid, so document fetches and doctor keep working', async () => {
    // The embeddings gate belongs to *search*. Gating openCorpus itself broke
    // get_nextjs_manual (an agent could not read a document it had the id for)
    // and made `doctor` report a perfectly good index as failed.
    const { root, docsLine } = await makeIndexedProject({ constraint: '^16.1.0' });
    const config = await hybridConfigFor(root, 'never-indexed-model');

    const corpus = await openCorpus({ root, config });
    try {
      expect(corpus.documentCount).toBeGreaterThan(0);
      const [id] = corpus.repository.hashesFor(docsLine, 'en').keys();
      expect(corpus.repository.getDocument(id!)?.content).toBeTruthy();
    } finally {
      corpus.close();
    }
  });

  it('refuses a partially embedded corpus rather than ranking against a fraction of it', async () => {
    const { root, docsLine } = await makeIndexedProject({ constraint: '^16.1.0' });
    const config = await hybridConfigFor(root, 'half-done-model');
    const paths = harnessPaths(root);

    // Exactly the state an interrupted embedding run leaves behind: one vector.
    const seeding = ManualRepository.open(paths.indexFile);
    const [firstId] = seeding.hashesFor(docsLine, 'en').keys();
    seeding.upsertVector(firstId!, 'half-done-model', Float32Array.from([1, 0]));
    const total = seeding.countDocuments(docsLine, 'en');
    seeding.close();
    expect(total).toBeGreaterThan(1);

    const corpus = await openCorpus({ root, config });
    try {
      expect(() => corpus.requireEmbeddings()).toThrow(/only 1 of \d+ documents have embeddings/);
    } finally {
      corpus.close();
    }
  });

  it('resolves an embeddings provider once the corpus has been embedded for that model', async () => {
    const { root } = await makeIndexedProject({
      constraint: '^16.1.0',
      embeddings: makeFakeEmbeddingProvider('configured-model'),
    });
    const config = await hybridConfigFor(root, 'configured-model');

    // Constructing the real provider is safe and offline — it only imports
    // and calls the model lazily inside embed(), which this test never calls.
    const corpus = await openCorpus({ root, config });
    try {
      expect(corpus.searchStrategy).toBe('hybrid');
      expect(corpus.requireEmbeddings()?.model).toBe('configured-model');
    } finally {
      corpus.close();
    }
  });
});

describe('specs hybrid search', () => {
  it('refuses hybrid search on a spec index with no matching embeddings', async () => {
    const { root } = await makeIndexedProject({ constraint: '^16.1.0' });
    const repository = SpecRepository.open(specIndexFile(root));
    try {
      repository.insert(specChunk, new Date().toISOString());
    } finally {
      repository.close();
    }

    const corpus = await openSpecCorpus({
      root,
      enabled: true,
      searchStrategy: 'hybrid',
      embeddingModel: 'unused-model',
    });
    try {
      // Named the model the caller actually configured, never a silent default.
      expect(() => corpus.requireEmbeddings()).toThrow(/"unused-model"/);
      expect(() => corpus.requireEmbeddings()).toThrow(/not been fully indexed with embeddings/);
    } finally {
      corpus.close();
    }
  });

  it('indexes and searches specs in hybrid mode end to end', async () => {
    const { root } = await makeIndexedProject({ constraint: '^16.1.0' });
    const { writeFile, mkdir } = await import('node:fs/promises');
    const path = await import('node:path');
    await mkdir(path.join(root, 'docs'), { recursive: true });
    await writeFile(
      path.join(root, 'docs/billing.md'),
      '---\ntitle: "Billing"\n---\n\n# Billing\n\n## Invoice Numbering\n\nInvoices use a prefix and a sequence.\n',
      'utf8',
    );

    const embeddings = makeFakeEmbeddingProvider('spec-model');
    const indexing = SpecRepository.open(specIndexFile(root));
    try {
      const result = await indexSpecs({
        repository: indexing,
        root,
        include: ['docs/**/*.md'],
        exclude: [],
        embeddings,
      });
      expect(result.embedded).toBeGreaterThan(0);
    } finally {
      indexing.close();
    }

    // openSpecCorpus always resolves the *real* provider for the configured
    // model, since that is what production search actually uses — searching
    // with it here would need a real network-fetched model. So this checks
    // readiness only (never calls embed()); the search step below reuses our
    // own fake provider directly against the repository, exactly like the
    // manuals hybrid tests above, to stay fully offline.
    const corpus = await openSpecCorpus({
      root,
      enabled: true,
      searchStrategy: 'hybrid',
      embeddingModel: 'spec-model',
    });
    expect(corpus.searchStrategy).toBe('hybrid');
    expect(corpus.requireEmbeddings()?.model).toBe('spec-model');
    corpus.close();

    const searching = SpecRepository.open(specIndexFile(root));
    try {
      const outcome = await searchSpecs({
        repository: searching,
        query: 'invoice numbering',
        strategy: 'hybrid',
        embeddings,
      });

      expect(outcome.strategy).toBe('hybrid');
      expect(outcome.hits.length).toBeGreaterThan(0);
    } finally {
      searching.close();
    }
  });
});
