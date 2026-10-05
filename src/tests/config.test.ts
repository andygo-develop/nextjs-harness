import { readFile, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';

import { harnessPaths } from '../cli/nextjs/project.js';
import { buildVersion } from '../cli/nextjs/version.js';
import { ensureConfig, loadConfig, requireConfig, resetConfigCache, updateConfig } from '../generators/config-generator/config.js';
import { CURRENT_CONFIG_VERSION } from '../generators/config-generator/schema.js';
import { cleanupTempDirs, makeProject } from './helpers.js';

const v161 = buildVersion({ major: 16, minor: 1 }, 'package-lock.json', '16.1.4');

afterEach(cleanupTempDirs);

describe('configuration', () => {
  it('creates a config with the expected shape', async () => {
    const root = await makeProject({ constraint: '^16.1.0' });
    const { config, created } = await ensureConfig(root, v161);

    expect(created).toBe(true);
    expect(config).toMatchObject({
      configVersion: CURRENT_CONFIG_VERSION,
      nextjs: { version: '16.1', exactVersion: '16.1.4', docsLine: 'v16.3.8' },
      manuals: { source: 'official', language: 'en', repository: 'vercel/next.js' },
      index: { engine: 'sqlite', searchStrategy: 'bm25' },
      mcp: { transport: 'stdio', serverName: 'nextjs-docs' },
      targets: ['claude-code'],
      specs: { enabled: false },
    });
  });

  it('is idempotent — a second ensure creates nothing', async () => {
    const root = await makeProject({ constraint: '^16.1.0' });
    await ensureConfig(root, v161);
    resetConfigCache();

    const second = await ensureConfig(root, v161);
    expect(second.created).toBe(false);
    expect(second.versionChanged).toBe(false);
  });

  it('updates the stored version when the project upgrades', async () => {
    const root = await makeProject({ constraint: '^15.4.0' });
    await ensureConfig(root, buildVersion({ major: 15, minor: 4 }, 'package.json'));
    resetConfigCache();

    const upgraded = await ensureConfig(root, v161);
    expect(upgraded.versionChanged).toBe(true);
    expect(upgraded.config.nextjs).toMatchObject({ version: '16.1', docsLine: 'v16.3.8' });
  });

  it('preserves user edits to unrelated fields across a version change', async () => {
    const root = await makeProject({ constraint: '^16.1.0' });
    await ensureConfig(root, v161);
    await updateConfig(root, (config) => ({
      ...config,
      mcp: { ...config.mcp, serverName: 'my-nextjs-docs' },
    }));
    resetConfigCache();

    const { config } = await ensureConfig(root, buildVersion({ major: 16, minor: 2 }, 'package.json'));
    expect(config.mcp.serverName).toBe('my-nextjs-docs');
    expect(config.nextjs.version).toBe('16.2');
  });

  it('preserves unknown top-level keys written by a newer harness', async () => {
    const root = await makeProject({ constraint: '^16.1.0' });
    await ensureConfig(root, v161);

    const { configFile } = harnessPaths(root);
    const raw = JSON.parse(await readFile(configFile, 'utf8'));
    await writeFile(configFile, JSON.stringify({ ...raw, futureFeature: { enabled: true } }, null, 2));
    resetConfigCache();

    await loadConfig(root);
    await updateConfig(root, (config) => config);

    const after = JSON.parse(await readFile(configFile, 'utf8'));
    expect(after.futureFeature).toEqual({ enabled: true });
  });

  it('returns undefined when the project is not initialised', async () => {
    const root = await makeProject({ constraint: '^16.1.0' });
    expect(await loadConfig(root)).toBeUndefined();
  });

  it('tells the user to run setup when config is missing', async () => {
    const root = await makeProject({ constraint: '^16.1.0' });
    await expect(requireConfig(root)).rejects.toMatchObject({
      hint: expect.stringContaining('nextjs-harness setup'),
    });
  });

  it('rejects a config written by a newer harness', async () => {
    const root = await makeProject({ constraint: '^16.1.0' });
    await ensureConfig(root, v161);

    const { configFile } = harnessPaths(root);
    const raw = JSON.parse(await readFile(configFile, 'utf8'));
    await writeFile(configFile, JSON.stringify({ ...raw, configVersion: 99 }));
    resetConfigCache();

    await expect(loadConfig(root)).rejects.toThrow(/newer version of nextjs-harness/);
  });

  it('reports malformed JSON actionably', async () => {
    const root = await makeProject({ constraint: '^16.1.0' });
    await ensureConfig(root, v161);
    resetConfigCache();

    await writeFile(harnessPaths(root).configFile, '{ broken');
    await expect(loadConfig(root)).rejects.toThrow(/not valid JSON/);
  });

  it('rejects a config that is not an object', async () => {
    const root = await makeProject({ constraint: '^16.1.0' });
    await ensureConfig(root, v161);
    resetConfigCache();

    await writeFile(harnessPaths(root).configFile, '[1,2,3]');
    await expect(loadConfig(root)).rejects.toThrow(/must contain a JSON object/);
  });
});
