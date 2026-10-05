/**
 * `search_nextjs_manual` — ranked search over the project's Next.js manual.
 *
 * Results are deliberately compact: an agent gets title, section, version, URL,
 * a documentId and a short excerpt. Whole documents are fetched separately via
 * `get_nextjs_manual`, so a search never floods the context window.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { toExcerpt } from '../../rags/manuals/normalizer.js';
import { searchManuals } from '../../rags/manuals/search.js';
import type { McpContext, ToolResult } from '../context.js';
import { toolError } from '../context.js';

export const searchInputShape = {
  query: z
    .string()
    .min(1)
    .describe('Search terms, a Next.js API name, or a file convention. e.g. "revalidate data after a server action"'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(25)
    .optional()
    .describe('Maximum number of results to return (default 5).'),
};

export const searchOutputShape = {
  query: z.string(),
  version: z.string().describe('Documentation ref searched, e.g. "v16.3.8" or "v15.5.27".'),
  projectVersion: z.string().describe("The project's Next.js version, e.g. \"16.1\"."),
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

export async function runSearchTool(
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
      count: results.length,
      results,
    };

    const text =
      results.length === 0
        ? `No results for "${input.query}" in the Next.js ${corpus.docsLine} manual.`
        : [
            `${results.length} result(s) from the Next.js ${corpus.docsLine} manual ` +
              `(project version ${corpus.projectVersion}):`,
            '',
            ...results.map((result, index) =>
              [
                `${index + 1}. ${result.heading ? `${result.title} › ${result.heading}` : result.title}`,
                `   section: ${result.section}`,
                `   url: ${result.url}`,
                `   documentId: ${result.documentId}`,
                `   ${result.excerpt}`,
              ].join('\n'),
            ),
            '',
            'Use get_nextjs_manual with a documentId to read a full document.',
          ].join('\n');

    return { content: [{ type: 'text', text }], structuredContent };
  } catch (error) {
    return toolError(error);
  } finally {
    corpus.close();
  }
}

export function registerSearchManual(server: McpServer, context: McpContext): void {
  server.registerTool(
    'search_nextjs_manual',
    {
      title: 'Search Next.js manual',
      description:
        'Search the official Next.js documentation for the version this project uses. ' +
        'Use this before writing Next.js code whose API, options or behaviour you are unsure of. ' +
        'Returns ranked excerpts with a documentId for fetching the full document.',
      inputSchema: searchInputShape,
      outputSchema: searchOutputShape,
    },
    async (input) => runSearchTool(context, input) as never,
  );
}
