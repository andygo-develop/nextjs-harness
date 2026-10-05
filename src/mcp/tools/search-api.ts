/**
 * `search_nextjs_api` — look up a Next.js function, component, hook or config option.
 *
 * Today this is a focused view over the same manual index: the query is biased
 * toward the API-shaped parts of a page (function signatures appear in the
 * prose and in code samples). It exists as its own tool, with its own module,
 * so a dedicated API-reference index can replace the implementation later
 * without changing the tool contract agents already depend on.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { toExcerpt } from '../../rags/manuals/normalizer.js';
import { searchManuals } from '../../rags/manuals/search.js';
import type { McpContext, ToolResult } from '../context.js';
import { toolError } from '../context.js';

export const apiInputShape = {
  query: z
    .string()
    .min(1)
    .describe('A Next.js function, component, hook or config option, e.g. "revalidateTag", "useRouter" or "generateStaticParams".'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(25)
    .optional()
    .describe('Maximum number of results to return (default 5).'),
};

export const apiOutputShape = {
  query: z.string(),
  version: z.string(),
  projectVersion: z.string(),
  source: z.literal('manual').describe('Which index answered — "manual" until a dedicated API index exists.'),
  count: z.number().int(),
  results: z.array(
    z.object({
      documentId: z.string(),
      title: z.string(),
      heading: z.string().optional(),
      section: z.string(),
      version: z.string(),
      url: z.string(),
      excerpt: z.string(),
    }),
  ),
};

export async function runSearchApiTool(
  context: McpContext,
  input: { query: string; limit?: number },
): Promise<ToolResult> {
  let corpus;
  try {
    corpus = await context.openCorpus();
  } catch (error) {
    return toolError(error);
  }

  try {
    const outcome = await searchManuals({
      repository: corpus.repository,
      docsLine: corpus.docsLine,
      lang: corpus.lang,
      query: input.query,
      limit: input.limit ?? 5,
      strategy: corpus.searchStrategy,
      embeddings: corpus.requireEmbeddings(),
    });

    const results = outcome.hits.map((hit) => ({
      documentId: hit.id,
      title: hit.title,
      ...(hit.heading ? { heading: hit.heading } : {}),
      section: hit.section,
      version: corpus.docsLine,
      url: hit.url,
      excerpt: toExcerpt(hit.snippet || hit.content, 400),
    }));

    const structuredContent = {
      query: input.query,
      version: corpus.docsLine,
      projectVersion: corpus.projectVersion,
      source: 'manual' as const,
      count: results.length,
      results,
    };

    const text =
      results.length === 0
        ? `No Next.js ${corpus.docsLine} documentation found for "${input.query}". ` +
          'The symbol may not exist in this version — do not assume it does.'
        : [
            `${results.length} result(s) for "${input.query}" in the Next.js ${corpus.docsLine} manual:`,
            '',
            ...results.map((result, index) =>
              [
                `${index + 1}. ${result.heading ? `${result.title} › ${result.heading}` : result.title}`,
                `   url: ${result.url}`,
                `   documentId: ${result.documentId}`,
                `   ${result.excerpt}`,
              ].join('\n'),
            ),
          ].join('\n');

    return { content: [{ type: 'text', text }], structuredContent };
  } catch (error) {
    return toolError(error);
  } finally {
    corpus.close();
  }
}

export function registerSearchApi(server: McpServer, context: McpContext): void {
  server.registerTool(
    'search_nextjs_api',
    {
      title: 'Search Next.js API',
      description:
        'Look up a Next.js function, component, hook, file convention or config option in the ' +
        'documentation for the version this project uses. Use this to confirm an API or its ' +
        'signature exists before writing code that calls it.',
      inputSchema: apiInputShape,
      outputSchema: apiOutputShape,
    },
    async (input) => runSearchApiTool(context, input) as never,
  );
}
