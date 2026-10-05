import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { readFile, rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';

import { harnessPaths } from '../cli/nextjs/project.js';
import { packageVersion } from '../package-version.js';
import { createMcpContext } from '../mcp/context.js';
import { createServer, SERVER_NAME } from '../mcp/server.js';
import { runGetTool } from '../mcp/tools/get-manual.js';
import { runSearchApiTool } from '../mcp/tools/search-api.js';
import { runSearchTool } from '../mcp/tools/search-manual.js';
import { cleanupTempDirs, FIXTURE_PATHS, makeIndexedProject, makeProject } from './helpers.js';

afterEach(cleanupTempDirs);

/** Connects a real MCP client to the server over an in-memory transport. */
async function connect(root: string) {
  const server = createServer(createMcpContext(root));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1.0.0' });

  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, close: () => client.close() };
}

describe('server identity', () => {
  /**
   * The handshake version used to be a hardcoded constant, and
   * `process.env.npm_package_version` — the other tempting source — is unset
   * for every way this actually runs (global install, npx, launched by a
   * coding agent). Both make a client, and any bug report it produces, name
   * the wrong release.
   */
  it('reports the real package version, not a placeholder', async () => {
    const { version } = JSON.parse(
      await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { version: string };

    expect(packageVersion()).toBe(version);

    const { root } = await makeIndexedProject({ constraint: '^16.1.0' });
    const { client, close } = await connect(root);

    try {
      expect(client.getServerVersion()).toMatchObject({ name: SERVER_NAME, version });
    } finally {
      await close();
    }
  });
});

describe('server startup and tool registration', () => {
  it('registers the manual tools and the project spec tools', async () => {
    const { root } = await makeIndexedProject({ constraint: '^16.1.0' });
    const { client, close } = await connect(root);

    try {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual([
        'get_nextjs_manual',
        'get_project_spec',
        'search_nextjs_api',
        'search_nextjs_manual',
        'search_project_specs',
      ]);
    } finally {
      await close();
    }
  });

  it('describes the two corpora as distinct so an agent does not conflate them', async () => {
    const { root } = await makeIndexedProject({ constraint: '^16.1.0' });
    const { client, close } = await connect(root);

    try {
      const { tools } = await client.listTools();
      const specs = tools.find((tool) => tool.name === 'search_project_specs')!;

      expect(specs.description).toMatch(/not Next.js framework documentation/i);
      expect(client.getInstructions()).toMatch(/never present a project design note as/i);
    } finally {
      await close();
    }
  });

  it('advertises input schemas agents can call', async () => {
    const { root } = await makeIndexedProject({ constraint: '^16.1.0' });
    const { client, close } = await connect(root);

    try {
      const { tools } = await client.listTools();
      const search = tools.find((tool) => tool.name === 'search_nextjs_manual')!;

      expect(Object.keys(search.inputSchema.properties ?? {})).toEqual(['query', 'limit']);
      expect(search.inputSchema.required).toEqual(['query']);
      expect(search.description).toMatch(/Next.js/);
    } finally {
      await close();
    }
  });

  it('starts even when the project has no index, so tools can explain why', async () => {
    const root = await makeProject({ constraint: '^16.1.0' });
    const { client, close } = await connect(root);

    try {
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(5);
    } finally {
      await close();
    }
  });

  it('answers a real tools/call over the transport', async () => {
    const { root } = await makeIndexedProject({ constraint: '^16.1.0' });
    const { client, close } = await connect(root);

    try {
      const result = await client.callTool({
        name: 'search_nextjs_manual',
        arguments: { query: 'set a cookie', limit: 2 },
      });

      expect(result.isError ?? false).toBe(false);
      expect(result.structuredContent).toMatchObject({ version: 'v16.3.8', projectVersion: '16.1' });
    } finally {
      await close();
    }
  });
});

describe('search_nextjs_manual', () => {
  it('returns compact ranked results with a documentId', async () => {
    const { root } = await makeIndexedProject({ constraint: '^16.1.0' });
    const result = await runSearchTool(createMcpContext(root), { query: 'set a cookie', limit: 3 });

    expect(result.isError).toBeUndefined();
    const structured = result.structuredContent as {
      count: number;
      version: string;
      projectVersion: string;
      results: Array<Record<string, string>>;
    };

    expect(structured.version).toBe('v16.3.8');
    expect(structured.projectVersion).toBe('16.1');
    expect(structured.count).toBeGreaterThan(0);
    expect(structured.results[0]).toMatchObject({
      title: 'cookies',
      heading: 'Setting a cookie',
      section: 'App Router › API Reference',
      version: 'v16.3.8',
      url: 'https://nextjs.org/docs/app/api-reference/functions/cookies#setting-a-cookie',
      documentId: `v16.3.8:en:${FIXTURE_PATHS.cookies}#setting-a-cookie`,
      excerpt: expect.any(String),
    });
  });

  it('returns excerpts rather than whole documents', async () => {
    const { root } = await makeIndexedProject({ constraint: '^16.1.0' });
    const result = await runSearchTool(createMcpContext(root), { query: 'cookies' });
    const structured = result.structuredContent as { results: Array<{ excerpt: string }> };

    for (const hit of structured.results) {
      expect(hit.excerpt.length).toBeLessThanOrEqual(420);
    }
  });

  it('reports a missing index as an actionable tool error', async () => {
    const { root } = await makeIndexedProject({ constraint: '^16.1.0' });
    await rm(harnessPaths(root).indexFile, { force: true });

    const result = await runSearchTool(createMcpContext(root), { query: 'cookies' });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('nextjs-harness manuals update');
  });

  it('refuses to answer from another major version', async () => {
    const { root } = await makeIndexedProject({ constraint: '^15.4.0', versions: ['v16.3.8'] });
    const result = await runSearchTool(createMcpContext(root), { query: 'cookies' });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('has not been synchronized');
    expect(result.content[0]!.text).not.toContain('nextjs.org/docs');
  });

  it('reports a non-Next.js directory clearly', async () => {
    const root = await makeProject({ nonNextJs: true });
    const result = await runSearchTool(createMcpContext(root), { query: 'cookies' });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('Next.js project not detected');
  });

  it('handles a query with no matches without erroring', async () => {
    const { root } = await makeIndexedProject({ constraint: '^16.1.0' });
    const result = await runSearchTool(createMcpContext(root), { query: 'zzzznotpresent' });

    expect(result.isError).toBeUndefined();
    expect((result.structuredContent as { count: number }).count).toBe(0);
  });
});

describe('get_nextjs_manual', () => {
  it('returns the full document and its metadata', async () => {
    const { root } = await makeIndexedProject({ constraint: '^16.1.0' });
    const context = createMcpContext(root);

    const search = await runSearchTool(context, { query: 'set a cookie', limit: 1 });
    const documentId = (search.structuredContent as { results: Array<{ documentId: string }> }).results[0]!
      .documentId;

    const result = await runGetTool(context, { documentId });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      documentId,
      title: 'cookies',
      heading: 'Setting a cookie',
      section: 'App Router › API Reference',
      version: 'v16.3.8',
      projectVersion: '16.1',
      url: 'https://nextjs.org/docs/app/api-reference/functions/cookies#setting-a-cookie',
      path: FIXTURE_PATHS.cookies,
      content: expect.stringContaining("cookieStore.set('name', 'lee', { secure: true })"),
    });

    const text = result.content[0]!.text;
    expect(text).toContain('# cookies › Setting a cookie');
    expect(text).toContain('version: Next.js v16.3.8 (project 16.1)');
  });

  it('reports an unknown documentId as an error', async () => {
    const { root } = await makeIndexedProject({ constraint: '^16.1.0' });
    const result = await runGetTool(createMcpContext(root), { documentId: 'does-not-exist' });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('search_nextjs_manual');
  });

  it('refuses a documentId belonging to a different Next.js version', async () => {
    // The 15.x manual is indexed in the same database, but the project is on 16.1.
    const { root } = await makeIndexedProject({ constraint: '^16.1.0', versions: ['v16.3.8', 'v15.5.27'] });
    const result = await runGetTool(createMcpContext(root), {
      documentId: `v15.5.27:en:${FIXTURE_PATHS.cookies}#setting-a-cookie`,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('Refusing to return documentation');
  });
});

describe('search_nextjs_api', () => {
  it('finds a function and reports which index answered', async () => {
    const { root } = await makeIndexedProject({ constraint: '^16.1.0' });
    const result = await runSearchApiTool(createMcpContext(root), { query: 'revalidateTag' });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ source: 'manual', version: 'v16.3.8' });

    const { count, results } = result.structuredContent as { count: number; results: Array<{ title: string }> };
    expect(count).toBeGreaterThan(0);
    expect(results[0]!.title).toBe('revalidateTag');
  });

  it('does not claim a symbol exists when nothing matches', async () => {
    const { root } = await makeIndexedProject({ constraint: '^16.1.0' });
    const result = await runSearchApiTool(createMcpContext(root), { query: 'totallyMadeUpMethod' });

    expect((result.structuredContent as { count: number }).count).toBe(0);
    expect(result.content[0]!.text).toContain('do not assume it does');
  });
});
