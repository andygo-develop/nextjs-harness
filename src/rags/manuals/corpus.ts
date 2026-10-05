/**
 * Version safety.
 *
 * This is the single place where "which documentation may this project see?"
 * is decided, and it is deliberately strict: a 16.x project is served the
 * `v16.3.8` corpus or nothing at all. There is no fallback to an adjacent
 * major version, because silently answering a 16.x question from 15.x
 * documentation is precisely the failure this tool exists to prevent.
 *
 * Both the CLI and the MCP server go through here.
 */
import { access } from 'node:fs/promises';

import { harnessPaths } from '../../cli/nextjs/project.js';
import { versionFromString } from '../../cli/nextjs/version.js';
import { HarnessError, commandHint } from '../../errors.js';
import type { HarnessConfig } from '../../generators/config-generator/schema.js';
import { embeddingsNotReadyError } from '../embeddings/hybrid.js';
import { createTransformersEmbeddingProvider } from '../embeddings/transformers-provider.js';
import type { EmbeddingProvider } from '../embeddings/provider.js';
import { ManualRepository } from './repository.js';

export interface ResolvedCorpus {
  repository: ManualRepository;
  /** Documentation ref actually being searched, e.g. "v16.3.8" or "v15.5.27". */
  docsLine: string;
  lang: string;
  /** Project version for display, e.g. "16.1". */
  projectVersion: string;
  documentCount: number;
  /** `index.searchStrategy` from config — pass straight through to searchManuals. */
  searchStrategy: 'bm25' | 'hybrid';
  /**
   * The provider `searchManuals` needs under `hybrid`, or `undefined` under
   * `bm25`.
   *
   * Resolved on demand rather than eagerly in `openCorpus`, because opening the
   * corpus is also how `get_nextjs_manual` and `doctor` reach it — and neither
   * needs a single embedding to do its job. Gating them on embeddings made a
   * perfectly good bm25 index look broken and left an agent unable to read a
   * document it already had the id for.
   *
   * @throws HarnessError when the strategy is `hybrid` and this corpus is not
   * fully embedded for the configured model.
   */
  requireEmbeddings(): EmbeddingProvider | undefined;
  close(): void;
}

export interface OpenCorpusOptions {
  root: string;
  config: HarnessConfig;
  /** Explicit `--version` override. Must still be a synchronised corpus. */
  versionOverride?: string;
}

async function fileExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Opens the index for the project's Next.js version.
 * Throws an actionable error rather than degrading to another version.
 */
export async function openCorpus(options: OpenCorpusOptions): Promise<ResolvedCorpus> {
  const paths = harnessPaths(options.root);
  const lang = options.config.manuals.language;

  const requested = options.versionOverride
    ? versionFromString(options.versionOverride)
    : undefined;

  const docsLine = requested?.docsLine ?? options.config.nextjs.docsLine;
  const projectVersion = requested?.version ?? options.config.nextjs.version;

  if (!(await fileExists(paths.indexFile))) {
    throw new HarnessError(`Next.js ${projectVersion} documentation index is missing.`, {
      hint: commandHint('nextjs-harness manuals update'),
    });
  }

  const repository = ManualRepository.open(paths.indexFile);
  const documentCount = repository.countDocuments(docsLine, lang);

  if (documentCount === 0) {
    // Report what *is* available so the message is diagnostic, but never use it.
    const available = repository
      .listManualVersions()
      .filter((row) => row.documentCount > 0)
      .map((row) => `nextjs-${row.docsLine} (${row.lang}, ${row.documentCount} documents)`);
    repository.close();

    const availability =
      available.length > 0
        ? `\n\nIndexed documentation for other versions is present but will not be used:\n${available
            .map((line) => `  ${line}`)
            .join('\n')}`
        : '';

    throw new HarnessError(
      `Next.js ${projectVersion} documentation has not been synchronized (corpus: nextjs-${docsLine}, language: ${lang}).`,
      {
        hint: `${commandHint(
          'nextjs-harness manuals sync',
          'nextjs-harness manuals index',
        )}\n\nOr in one step:\n\n  nextjs-harness manuals update${availability}`,
      },
    );
  }

  const searchStrategy = options.config.index.searchStrategy;
  const embeddingModel = options.config.index.embeddingModel;

  return {
    repository,
    docsLine,
    lang,
    projectVersion,
    documentCount,
    searchStrategy,
    requireEmbeddings: () => {
      if (searchStrategy !== 'hybrid') {
        return undefined;
      }

      const embedded = repository.vectorCount(docsLine, lang, embeddingModel);
      if (embedded < documentCount) {
        throw embeddingsNotReadyError({
          what: `nextjs-${docsLine}`,
          model: embeddingModel,
          embedded,
          total: documentCount,
          command: 'nextjs-harness manuals update',
        });
      }

      return createTransformersEmbeddingProvider(embeddingModel);
    },
    close: () => repository.close(),
  };
}
