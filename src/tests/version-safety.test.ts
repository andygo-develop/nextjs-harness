/**
 * The core guarantee: a project is served documentation for its own Next.js
 * major version, or an explicit error — never another version's docs.
 */
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { harnessPaths } from '../cli/nextjs/project.js';
import { loadContext } from '../cli/context.js';
import { requireConfig, resetConfigCache } from '../generators/config-generator/config.js';
import { openCorpus } from '../rags/manuals/corpus.js';
import { createMcpContext } from '../mcp/context.js';
import { runSearchTool } from '../mcp/tools/search-manual.js';
import { cleanupTempDirs, makeIndexedProject } from './helpers.js';

afterEach(cleanupTempDirs);

async function open(root: string, versionOverride?: string) {
  const config = await requireConfig(root);
  return openCorpus({ root, config, versionOverride });
}

describe('corpus resolution', () => {
  it('opens the corpus matching the project version', async () => {
    const { root } = await makeIndexedProject({ constraint: '^16.1.0' });
    const corpus = await open(root);

    try {
      expect(corpus.docsLine).toBe('v16.3.8');
      expect(corpus.projectVersion).toBe('16.1');
      expect(corpus.documentCount).toBeGreaterThan(0);
    } finally {
      corpus.close();
    }
  });

  it('errors when the index file does not exist at all', async () => {
    const { root } = await makeIndexedProject({ constraint: '^16.1.0' });
    await rm(harnessPaths(root).indexFile, { force: true });

    await expect(open(root)).rejects.toMatchObject({
      message: expect.stringContaining('index is missing'),
      hint: expect.stringContaining('nextjs-harness manuals update'),
    });
  });

  it('refuses to fall back to another major version', async () => {
    // The project is on 15.4, but only the 16.x documentation has been indexed.
    const { root } = await makeIndexedProject({ constraint: '^15.4.0', versions: ['v16.3.8'] });

    await expect(open(root)).rejects.toMatchObject({
      message: expect.stringContaining('Next.js 15.4 documentation has not been synchronized'),
    });
    await expect(open(root)).rejects.toMatchObject({
      message: expect.stringContaining('corpus: nextjs-v15.5.27'),
    });
  });

  it('names the other indexed versions but states they will not be used', async () => {
    const { root } = await makeIndexedProject({ constraint: '^15.4.0', versions: ['v16.3.8'] });

    await expect(open(root)).rejects.toMatchObject({
      hint: expect.stringContaining('will not be used'),
    });
    await expect(open(root)).rejects.toMatchObject({
      hint: expect.stringContaining('nextjs-v16.3.8'),
    });
  });

  it('tells the user exactly which commands to run', async () => {
    const { root } = await makeIndexedProject({ constraint: '^15.4.0', versions: ['v16.3.8'] });

    await expect(open(root)).rejects.toMatchObject({
      hint: expect.stringContaining('nextjs-harness manuals sync'),
    });
  });

  it('honours an explicit --version override when that corpus is indexed', async () => {
    const { root } = await makeIndexedProject({ constraint: '^16.1.0', versions: ['v16.3.8', 'v15.5.27'] });
    const corpus = await open(root, '15');

    try {
      expect(corpus.docsLine).toBe('v15.5.27');
    } finally {
      corpus.close();
    }
  });

  it('still refuses an explicit override for a version that is not indexed', async () => {
    const { root } = await makeIndexedProject({ constraint: '^16.1.0', versions: ['v16.3.8'] });

    await expect(open(root, '15')).rejects.toThrow(/has not been synchronized/);
  });

  it('rejects a nonsensical version override', async () => {
    const { root } = await makeIndexedProject({ constraint: '^16.1.0' });
    await expect(open(root, 'banana')).rejects.toThrow(/Could not understand Next.js version/);
  });

  it.each(['12', '9'])('rejects override %s, which has no documentation in this layout', async (version) => {
    const { root } = await makeIndexedProject({ constraint: '^16.1.0' });
    await expect(open(root, version)).rejects.toThrow(/No Next.js documentation is available/);
  });
});

/**
 * Regression: the stored config caches a detected version, so it goes stale as
 * soon as someone bumps next. Before this was fixed, a project upgraded from
 * 15.5 to 16.0 kept being served 15.x documentation, labelled as though it
 * were correct.
 */
describe('config drift after a Next.js upgrade', () => {
  /** Rewrites package.json to a new range, leaving the config stale. */
  async function upgradeProject(root: string, constraint: string): Promise<void> {
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ name: 'acme-blog', dependencies: { next: constraint } }, null, 2),
    );
    await rm(join(root, 'package-lock.json'), { force: true });
    resetConfigCache();
  }

  it('refuses to serve the old corpus after a major upgrade', async () => {
    const { root } = await makeIndexedProject({ constraint: '^15.5.0' });
    await upgradeProject(root, '^16.0.0');

    await expect(loadContext(root)).rejects.toMatchObject({
      message: expect.stringContaining('This project is now Next.js 16.0'),
      hint: expect.stringContaining('Refusing to use Next.js v15.5.27 documentation'),
    });
  });

  it('tells the user to re-run setup', async () => {
    const { root } = await makeIndexedProject({ constraint: '^15.5.0' });
    await upgradeProject(root, '^16.0.0');

    await expect(loadContext(root)).rejects.toMatchObject({
      hint: expect.stringContaining('nextjs-harness setup'),
    });
  });

  it('blocks the MCP tools too, rather than answering from the old corpus', async () => {
    const { root } = await makeIndexedProject({ constraint: '^15.5.0' });
    await upgradeProject(root, '^16.0.0');

    const result = await runSearchTool(createMcpContext(root), { query: 'cookies' });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('This project is now Next.js 16.0');
    expect(result.content[0]!.text).not.toContain('nextjs.org/docs');
  });

  it('also blocks a downgrade to an older major', async () => {
    const { root } = await makeIndexedProject({ constraint: '^16.1.0' });
    await upgradeProject(root, '^15.5.0');

    await expect(loadContext(root)).rejects.toThrow(/now Next.js 15.5/);
  });

  it('blocks an upgrade past the newest pinned major, which moves the project onto canary', async () => {
    const { root } = await makeIndexedProject({ constraint: '^16.1.0' });
    await upgradeProject(root, '^17.0.0');

    await expect(loadContext(root)).rejects.toMatchObject({
      message: expect.stringContaining('This project is now Next.js 17.0'),
      hint: expect.stringContaining('Refusing to use Next.js v16.3.8 documentation for a Next.js 17.0 project'),
    });
  });

  it('accepts a minor upgrade and refreshes the recorded version', async () => {
    const { root } = await makeIndexedProject({ constraint: '^16.1.0' });
    await upgradeProject(root, '^16.2.0');

    const context = await loadContext(root);
    expect(context.config.nextjs.version).toBe('16.2');
    expect(context.config.nextjs.docsLine).toBe('v16.3.8');

    // The refreshed version is persisted, not just returned.
    resetConfigCache();
    expect((await requireConfig(root)).nextjs.version).toBe('16.2');
  });

  it('lets a minor upgrade keep searching normally', async () => {
    const { root } = await makeIndexedProject({ constraint: '^16.1.0' });
    await upgradeProject(root, '^16.2.0');

    const result = await runSearchTool(createMcpContext(root), { query: 'cookies' });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ version: 'v16.3.8', projectVersion: '16.2' });
  });
});
