/**
 * `get_nextjs_manual` — fetch one full document by id.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { McpContext, ToolResult } from '../context.js';
import { toolError } from '../context.js';

export const getInputShape = {
  documentId: z
    .string()
    .min(1)
    .describe('documentId returned by search_nextjs_manual, e.g. "v16.3.8:en:01-app/03-api-reference/04-functions/cookies.mdx#version-history"'),
};

export const getOutputShape = {
  documentId: z.string(),
  title: z.string(),
  heading: z.string().optional(),
  section: z.string(),
  version: z.string(),
  projectVersion: z.string(),
  url: z.string(),
  path: z.string(),
  content: z.string(),
};

export async function runGetTool(
  context: McpContext,
  input: { documentId: string },
): Promise<ToolResult> {
  let corpus;
  try {
    corpus = await context.openCorpus();
  } catch (error) {
    return toolError(error);
  }

  try {
    const document = corpus.repository.getDocument(input.documentId);

    if (!document) {
      return {
        content: [
          {
            type: 'text',
            text:
              `No Next.js document found with id "${input.documentId}".\n\n` +
              'Use search_nextjs_manual to find a valid documentId.',
          },
        ],
        isError: true,
      };
    }

    // Version safety applies to direct fetches too: a documentId naming another
    // major line must not be readable from this project.
    if (document.docsLine !== corpus.docsLine || document.lang !== corpus.lang) {
      return {
        content: [
          {
            type: 'text',
            text:
              `Document "${input.documentId}" belongs to the Next.js ${document.docsLine} manual, ` +
              `but this project uses ${corpus.docsLine}. Refusing to return documentation ` +
              'for a different Next.js version.',
          },
        ],
        isError: true,
      };
    }

    const structuredContent = {
      documentId: document.id,
      title: document.title,
      ...(document.heading ? { heading: document.heading } : {}),
      section: document.section,
      version: corpus.docsLine,
      projectVersion: corpus.projectVersion,
      url: document.url,
      path: document.path,
      content: document.content,
    };

    const header = [
      `# ${document.title}${document.heading && document.heading !== document.title ? ` › ${document.heading}` : ''}`,
      `section: ${document.section}`,
      `version: Next.js ${corpus.docsLine} (project ${corpus.projectVersion})`,
      `url: ${document.url}`,
      '',
      '---',
      '',
    ].join('\n');

    return {
      content: [{ type: 'text', text: header + document.content }],
      structuredContent,
    };
  } catch (error) {
    return toolError(error);
  } finally {
    corpus.close();
  }
}

export function registerGetManual(server: McpServer, context: McpContext): void {
  server.registerTool(
    'get_nextjs_manual',
    {
      title: 'Get Next.js manual document',
      description:
        'Retrieve the full text of a Next.js documentation document by its documentId, ' +
        'as returned by search_nextjs_manual.',
      inputSchema: getInputShape,
      outputSchema: getOutputShape,
    },
    async (input) => runGetTool(context, input) as never,
  );
}
