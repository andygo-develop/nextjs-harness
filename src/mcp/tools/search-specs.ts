/**
 * `search_project_specs` and `get_project_spec`.
 *
 * These read the project's *own* written specs and documentation — a corpus
 * kept entirely separate from the Next.js manual. The tool descriptions say so
 * explicitly, because an agent must never present a project design note as
 * framework behaviour.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { requireNextJsProject } from '../../cli/nextjs/project.js';
import { requireConfig } from '../../generators/config-generator/config.js';
import { toExcerpt } from '../../rags/manuals/normalizer.js';
import { openSpecCorpus, searchSpecs } from '../../rags/specs/search.js';
import type { McpContext, ToolResult } from '../context.js';
import { toolError } from '../context.js';

export const searchSpecsInputShape = {
  query: z.string().min(1).describe('Search terms, e.g. "billing rules" or "invoice numbering".'),
  limit: z.number().int().min(1).max(25).optional().describe('Maximum results (default 5).'),
  tags: z
    .array(z.string().min(1))
    .optional()
    .describe(
      'Only return specs carrying at least one of these tags, as assigned to include paths in ' +
        'specs.include of .nextjs-harness/config.json, e.g. ["adr"]. Case-insensitive. Omit to search all specs.',
    ),
};

export const searchSpecsOutputShape = {
  query: z.string(),
  source: z.literal('project-specs'),
  count: z.number().int(),
  results: z.array(
    z.object({
      documentId: z.string(),
      title: z.string(),
      heading: z.string().optional(),
      section: z.string(),
      path: z.string().describe('Repository-relative path to the source file.'),
      tags: z.array(z.string()).describe('Tags of the include path(s) that matched this file.'),
      excerpt: z.string(),
    }),
  ),
};

export const getSpecInputShape = {
  documentId: z
    .string()
    .min(1)
    .describe('documentId from search_project_specs, e.g. "spec:docs/billing.md#invoice-numbering"'),
};

export const getSpecOutputShape = {
  documentId: z.string(),
  source: z.literal('project-specs'),
  title: z.string(),
  heading: z.string().optional(),
  section: z.string(),
  path: z.string(),
  tags: z.array(z.string()),
  content: z.string(),
};

async function openCorpus(context: McpContext) {
  const project = await requireNextJsProject(context.cwd);
  const config = await requireConfig(project.root);
  return openSpecCorpus({
    root: project.root,
    enabled: config.specs.enabled,
    // See the same spread in `specs search` — `embeddingModel` belongs to the
    // "hybrid" branch only.
    ...(config.index.searchStrategy === 'hybrid'
      ? { searchStrategy: 'hybrid' as const, embeddingModel: config.index.embeddingModel }
      : { searchStrategy: 'bm25' as const }),
  });
}

export async function runSearchSpecsTool(
  context: McpContext,
  input: { query: string; limit?: number; tags?: string[] },
): Promise<ToolResult> {
  let corpus;
  try {
    corpus = await openCorpus(context);
  } catch (error) {
    return toolError(error);
  }

  try {
    const outcome = await searchSpecs({
      repository: corpus.repository,
      query: input.query,
      limit: input.limit ?? 5,
      strategy: corpus.searchStrategy,
      embeddings: corpus.requireEmbeddings(),
      ...(input.tags && input.tags.length > 0 ? { tags: input.tags } : {}),
    });

    const results = outcome.hits.map((hit) => ({
      documentId: hit.id,
      title: hit.title,
      ...(hit.heading ? { heading: hit.heading } : {}),
      section: hit.section,
      path: hit.path,
      tags: hit.tags,
      excerpt: toExcerpt(hit.snippet || hit.content, 400),
    }));

    const text =
      results.length === 0
        ? `No project specs matched "${input.query}"` +
          (input.tags && input.tags.length > 0 ? ` with tags: ${input.tags.join(', ')}.` : '.')
        : [
            `${results.length} result(s) from this project's own specs ` +
              '(project documentation, not Next.js framework documentation):',
            '',
            ...results.map((result, index) =>
              [
                `${index + 1}. ${result.heading ? `${result.title} › ${result.heading}` : result.title}`,
                `   file: ${result.path}`,
                ...(result.tags.length > 0 ? [`   tags: ${result.tags.join(', ')}`] : []),
                `   documentId: ${result.documentId}`,
                `   ${result.excerpt}`,
              ].join('\n'),
            ),
            '',
            'Use get_project_spec with a documentId to read a full document.',
          ].join('\n');

    return {
      content: [{ type: 'text', text }],
      structuredContent: {
        query: input.query,
        source: 'project-specs' as const,
        count: results.length,
        results,
      },
    };
  } catch (error) {
    return toolError(error);
  } finally {
    corpus.close();
  }
}

export async function runGetSpecTool(
  context: McpContext,
  input: { documentId: string },
): Promise<ToolResult> {
  let corpus;
  try {
    corpus = await openCorpus(context);
  } catch (error) {
    return toolError(error);
  }

  try {
    const spec = corpus.repository.get(input.documentId);

    if (!spec) {
      return {
        content: [
          {
            type: 'text',
            text:
              `No project spec found with id "${input.documentId}".\n\n` +
              'Use search_project_specs to find a valid documentId.',
          },
        ],
        isError: true,
      };
    }

    const header = [
      `# ${spec.title}${spec.heading && spec.heading !== spec.title ? ` › ${spec.heading}` : ''}`,
      `source: this project's own specs (not Next.js framework documentation)`,
      `file: ${spec.path}`,
      ...(spec.tags.length > 0 ? [`tags: ${spec.tags.join(', ')}`] : []),
      '',
      '---',
      '',
    ].join('\n');

    return {
      content: [{ type: 'text', text: header + spec.content }],
      structuredContent: {
        documentId: spec.id,
        source: 'project-specs' as const,
        title: spec.title,
        ...(spec.heading ? { heading: spec.heading } : {}),
        section: spec.section,
        path: spec.path,
        tags: spec.tags,
        content: spec.content,
      },
    };
  } catch (error) {
    return toolError(error);
  } finally {
    corpus.close();
  }
}

export function registerSpecTools(server: McpServer, context: McpContext): void {
  server.registerTool(
    'search_project_specs',
    {
      title: 'Search project specs',
      description:
        "Search THIS PROJECT'S own written specs and documentation (requirements, design notes, ADRs). " +
        'This is project knowledge, not Next.js framework documentation — use search_nextjs_manual for that. ' +
        'Use this to find how this particular project is meant to behave. ' +
        'Pass tags to narrow the search to specs whose include path carries one of them.',
      inputSchema: searchSpecsInputShape,
      outputSchema: searchSpecsOutputShape,
    },
    async (input) => runSearchSpecsTool(context, input) as never,
  );

  server.registerTool(
    'get_project_spec',
    {
      title: 'Get project spec document',
      description:
        "Retrieve the full text of one of this project's own spec documents by documentId, " +
        'as returned by search_project_specs.',
      inputSchema: getSpecInputShape,
      outputSchema: getSpecOutputShape,
    },
    async (input) => runGetSpecTool(context, input) as never,
  );
}
