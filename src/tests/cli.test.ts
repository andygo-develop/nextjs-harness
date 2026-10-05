/**
 * Command-level tests.
 *
 * These drive the same functions the CLI wires to commander, with output
 * captured, so they cover real command behaviour without spawning processes or
 * touching the network. Commands that sync (`manuals sync` / `update`) are
 * exercised through their offline halves; the network path is covered by the
 * downloader tests.
 */
import { readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AGENT_NAMES, agentsDirFor } from '../generators/agent/installer.js';
import { harnessPaths } from '../cli/nextjs/project.js';
import { loadConfig, resetConfigCache, updateConfig } from '../generators/config-generator/config.js';
import { agentInstallCommand } from '../cli/commands/agent/install.js';
import { initCommand, runInit } from '../cli/commands/init.js';
import { indexCommand } from '../cli/commands/manuals/index.js';
import { searchCommand } from '../cli/commands/manuals/search.js';
import { statusCommand } from '../cli/commands/manuals/status.js';
import { versionsCommand } from '../cli/commands/manuals/versions.js';
import { mcpStatusCommand } from '../cli/commands/mcp/status.js';
import { setupCommand } from '../cli/commands/setup.js';
import { skillInstallCommand } from '../cli/commands/skill/install.js';
import { skillDirFor } from '../generators/skill/installer.js';
import { cleanupTempDirs, makeIndexedProject, makeProject, writeFixtureManuals } from './helpers.js';

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTempDirs();
});

/** Captures everything the command writes to stdout and stderr. */
async function capture(run: () => Promise<void>): Promise<string> {
  let output = '';
  const sink = (chunk: unknown): boolean => {
    output += String(chunk);
    return true;
  };

  vi.spyOn(process.stdout, 'write').mockImplementation(sink as never);
  vi.spyOn(process.stderr, 'write').mockImplementation(sink as never);

  try {
    await run();
  } finally {
    vi.restoreAllMocks();
  }

  return output;
}

describe('init', () => {
  it('creates the harness directory structure', async () => {
    const root = await makeProject({ constraint: '^16.1.0', lockVersion: '16.1.4' });
    const output = await capture(() => initCommand(root));

    expect(output).toContain('Next.js 16.1 project detected');
    expect(output).toContain('nextjs-v16.3.8');

    const paths = harnessPaths(root);
    await expect(readFile(paths.configFile, 'utf8')).resolves.toBeTruthy();
    for (const dir of [paths.manualsDir, paths.indexDir, paths.cacheDir]) {
      expect((await stat(dir)).isDirectory()).toBe(true);
    }
    expect((await loadConfig(root))?.nextjs).toMatchObject({ version: '16.1', exactVersion: '16.1.4', docsLine: 'v16.3.8' });
  });

  it('is idempotent', async () => {
    const root = await makeProject({ constraint: '^16.1.0' });
    await runInit(root);
    resetConfigCache();

    const output = await capture(() => initCommand(root));
    expect(output).toContain('Already initialised');
  });

  it('fails with an actionable error outside a Next.js project', async () => {
    const root = await makeProject({ nonNextJs: true });
    await expect(runInit(root)).rejects.toThrow(/Next.js project not detected/);
  });
});

describe('manuals index', () => {
  it('indexes synced manuals and reports counts', async () => {
    const root = await makeProject({ constraint: '^16.1.0' });
    await runInit(root);
    await writeFixtureManuals(root, 'v16.3.8');

    const output = await capture(() => indexCommand({ cwd: root }));
    expect(output).toMatch(/Indexed \d+ documents/);
  });

  it('reports nothing to do on a second run', async () => {
    const { root } = await makeIndexedProject({ constraint: '^16.1.0' });
    const output = await capture(() => indexCommand({ cwd: root }));

    expect(output).toContain('already current');
  });

  it('explains what to run when nothing has been synced', async () => {
    const root = await makeProject({ constraint: '^16.1.0' });
    await runInit(root);

    await expect(indexCommand({ cwd: root })).rejects.toMatchObject({
      hint: expect.stringContaining('nextjs-harness manuals sync'),
    });
  });
});

describe('manuals search', () => {
  it('prints ranked, human-readable results', async () => {
    const { root } = await makeIndexedProject({ constraint: '^16.1.0' });
    const output = await capture(() => searchCommand('set a cookie', { cwd: root, limit: 3 }));

    expect(output).toContain('1. cookies › Setting a cookie');
    expect(output).toContain('Section: App Router › API Reference');
    expect(output).toContain('Version: v16.3.8 (project: 16.1)');
    expect(output).toContain('URL: https://nextjs.org/docs/app/api-reference/functions/cookies#setting-a-cookie');
  });

  it('honours --limit', async () => {
    const { root } = await makeIndexedProject({ constraint: '^16.1.0' });
    const output = await capture(() => searchCommand('the', { cwd: root, limit: 1 }));

    expect(output).toContain('1. ');
    expect(output).not.toContain('2. ');
  });

  it('prints whole documents with --full', async () => {
    const { root } = await makeIndexedProject({ constraint: '^16.1.0' });
    const full = await capture(() => searchCommand('set a cookie', { cwd: root, limit: 1, full: true }));
    const brief = await capture(() => searchCommand('set a cookie', { cwd: root, limit: 1 }));

    // --full prints the indexed document, headings and code fences included;
    // the excerpt view flattens those away.
    expect(full).toContain('## Setting a cookie');
    expect(full).toContain('```ts filename="app/actions.ts" switcher');
    expect(brief).not.toContain('```ts');
    expect(full).not.toContain('Use --full');
    // The JavaScript twin of the sample was never indexed.
    expect(full).not.toContain('app/actions.js');
  });

  it('reports no results without failing', async () => {
    const { root } = await makeIndexedProject({ constraint: '^16.1.0' });
    const output = await capture(() => searchCommand('zzzznotpresent', { cwd: root }));

    expect(output).toContain('No results');
  });

  it('refuses to search a version that is not synced', async () => {
    const { root } = await makeIndexedProject({ constraint: '^16.1.0', versions: ['v16.3.8'] });

    await expect(searchCommand('cookies', { cwd: root, version: '15' })).rejects.toThrow(
      /has not been synchronized/,
    );
  });
});

describe('manuals status and versions', () => {
  it('reports a current index', async () => {
    const { root } = await makeIndexedProject({ constraint: '^16.1.0' });
    const output = await capture(() => statusCommand({ cwd: root }));

    expect(output).toContain('Next.js version:   16.1');
    expect(output).toContain('Index is current');
  });

  it('emits JSON when asked', async () => {
    const { root } = await makeIndexedProject({ constraint: '^16.1.0' });
    const output = await capture(() => statusCommand({ cwd: root, json: true }));
    const status = JSON.parse(output);

    expect(status).toMatchObject({ projectVersion: '16.1', docsLine: 'v16.3.8', indexed: true });
    expect(status.documentCount).toBeGreaterThan(0);
  });

  it('tells an un-synced project what to run', async () => {
    const root = await makeProject({ constraint: '^16.1.0' });
    await runInit(root);

    const output = await capture(() => statusCommand({ cwd: root }));
    expect(output).toContain('not synchronized');
    expect(output).toContain('nextjs-harness manuals update');
  });

  it('lists documentation lines and marks the project one', async () => {
    const { root } = await makeIndexedProject({ constraint: '^16.1.0' });
    const output = await capture(() => versionsCommand({ cwd: root }));

    for (const line of ['nextjs-v16.3.8', 'nextjs-v15.5.27', 'nextjs-v14.2.35', 'nextjs-v13.5.11']) {
      expect(output).toContain(line);
    }
    expect(output).toMatch(/nextjs-v16\.3\.8\s+yes\s+yes\s+\d+/);
    // Another major's line is listed, but neither the project's nor synced.
    expect(output).toMatch(/nextjs-v15\.5\.27\s+-\s+-\s+-/);
  });

  /**
   * A project on a major newer than any pinned release is served `canary`.
   * That line is not in SUPPORTED_MAJORS, and listing only those printed a
   * table in which no row was marked as the one actually in use.
   */
  it('lists the project line even when it is not a pinned major', async () => {
    const root = await makeProject({ constraint: '^17.0.0' });
    await runInit(root);

    const output = await capture(() => versionsCommand({ cwd: root }));

    expect(output).toContain('nextjs-canary');
    expect(output).toMatch(/nextjs-canary\s+yes/);
  });
});

describe('skill install', () => {
  it('installs and reports the location', async () => {
    const root = await makeProject({ constraint: '^16.1.0' });
    const output = await capture(() => skillInstallCommand({ cwd: root }));

    expect(output).toContain('Installed Next.js Skill');
    await expect(readFile(path.join(skillDirFor(root), 'SKILL.md'), 'utf8')).resolves.toContain('nextjs');
  });

  it('reports already-current on a second run', async () => {
    const root = await makeProject({ constraint: '^16.1.0' });
    await capture(() => skillInstallCommand({ cwd: root }));

    const output = await capture(() => skillInstallCommand({ cwd: root }));
    expect(output).toContain('already current');
  });
});

describe('agent install', () => {
  it('installs every agent and reports them by name', async () => {
    const root = await makeProject({ constraint: '^16.1.0' });
    const output = await capture(() => agentInstallCommand({ cwd: root }));

    expect(output).toContain('Installed Next.js agents');

    for (const name of AGENT_NAMES) {
      expect(output).toContain(name);
      await expect(
        readFile(path.join(agentsDirFor(root), `${name}.md`), 'utf8'),
      ).resolves.toContain(`name: ${name}`);
    }
  });

  it('reports already-current on a second run', async () => {
    const root = await makeProject({ constraint: '^16.1.0' });
    await capture(() => agentInstallCommand({ cwd: root }));

    const output = await capture(() => agentInstallCommand({ cwd: root }));
    expect(output).toContain('already current');
  });

  it('uses the project’s configured MCP server name', async () => {
    const root = await makeProject({ constraint: '^16.1.0' });
    await runInit(root);
    await updateConfig(root, (config) => ({
      ...config,
      mcp: { ...config.mcp, serverName: 'next-manual' },
    }));

    await capture(() => agentInstallCommand({ cwd: root }));

    const installed = await readFile(path.join(agentsDirFor(root), 'nextjs-expert.md'), 'utf8');
    expect(installed).toContain('mcp__next-manual__search_nextjs_manual');
  });
});

describe('mcp status', () => {
  it('warns when not registered with Claude Code', async () => {
    const { root } = await makeIndexedProject({ constraint: '^16.1.0' });
    const output = await capture(() => mcpStatusCommand({ cwd: root }));

    expect(output).toContain('Not registered with Claude Code');
    expect(output).toContain('search_nextjs_manual');
  });

  it('warns when the documentation index is empty', async () => {
    const { root } = await makeIndexedProject({ constraint: '^16.1.0' });
    await rm(harnessPaths(root).indexFile, { force: true });

    const output = await capture(() => mcpStatusCommand({ cwd: root }));
    expect(output).toContain('index is empty');
  });

  it('emits JSON when asked', async () => {
    const { root } = await makeIndexedProject({ constraint: '^16.1.0' });
    const output = await capture(() => mcpStatusCommand({ cwd: root, json: true }));

    expect(JSON.parse(output)).toMatchObject({
      serverName: 'nextjs-docs',
      transport: 'stdio',
      documentationReady: true,
      tools: ['search_nextjs_manual', 'get_nextjs_manual', 'search_nextjs_api'],
    });
  });
});

describe('setup', () => {
  it('runs the offline steps and registers the MCP server with --yes', async () => {
    const root = await makeProject({ constraint: '^16.1.0', lockVersion: '16.1.4' });
    const output = await capture(() =>
      setupCommand({ cwd: root, manuals: false, mcp: true, yes: true }),
    );

    expect(output).toContain('Next.js 16.1 detected');
    expect(output).toContain('Installed Next.js Skill');
    expect(output).toContain('Installed Next.js agents');
    expect(output).toContain('Setup complete');

    // The agent ships wired to the project's MCP server.
    await expect(readFile(path.join(agentsDirFor(root), 'nextjs-expert.md'), 'utf8')).resolves.toContain(
      'mcp__nextjs-docs__search_nextjs_manual',
    );

    const mcpConfig = JSON.parse(await readFile(path.join(root, '.mcp.json'), 'utf8'));
    expect(mcpConfig.mcpServers['nextjs-docs'].args).toEqual([
      '-y',
      '@andygo.dev/nextjs-harness',
      'mcp',
      'start',
    ]);
  });

  it('does not write .mcp.json when the prompt is declined', async () => {
    const root = await makeProject({ constraint: '^16.1.0' });
    // Non-interactive and no --yes: confirm() returns false.
    const output = await capture(() => setupCommand({ cwd: root, manuals: false, mcp: true }));

    expect(output).toContain('Skipped Claude Code registration');
    await expect(readFile(path.join(root, '.mcp.json'), 'utf8')).rejects.toThrow();
  });

  it('skips MCP entirely with --no-mcp', async () => {
    const root = await makeProject({ constraint: '^16.1.0' });
    const output = await capture(() => setupCommand({ cwd: root, manuals: false, mcp: false }));

    expect(output).not.toContain('Claude Code MCP integration');
    await expect(readFile(path.join(root, '.mcp.json'), 'utf8')).rejects.toThrow();
  });

  it('is idempotent', async () => {
    const root = await makeProject({ constraint: '^16.1.0' });
    await capture(() => setupCommand({ cwd: root, manuals: false, mcp: true, yes: true }));
    resetConfigCache();

    const output = await capture(() => setupCommand({ cwd: root, manuals: false, mcp: true, yes: true }));

    expect(output).toContain('Already registered');
    expect(output).toContain('Skill already current');

    const mcpConfig = JSON.parse(await readFile(path.join(root, '.mcp.json'), 'utf8'));
    expect(Object.keys(mcpConfig.mcpServers)).toEqual(['nextjs-docs']);
  });

  it('fails clearly outside a Next.js project', async () => {
    const root = await makeProject({ nonNextJs: true });
    await capture(async () => {
      await expect(setupCommand({ cwd: root, manuals: false, mcp: false })).rejects.toThrow(
        /Next.js project not detected/,
      );
    });
  });
});
