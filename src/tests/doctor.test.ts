import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { harnessPaths } from '../cli/nextjs/project.js';
import { runInit } from '../cli/commands/init.js';
import {
  DOCTOR_COMMANDS,
  doctorCommand,
  runDoctor,
  type DoctorReport,
} from '../cli/commands/doctor.js';
import { resetConfigCache, updateConfig } from '../generators/config-generator/config.js';
import { installSkill } from '../generators/skill/installer.js';
import { cleanupTempDirs, makeIndexedProject, makeProject } from './helpers.js';

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTempDirs();
});

const EXPECTED_ORDER = [
  'Next.js project detected',
  'Next.js version',
  'Manuals synchronized',
  'Documentation index available',
  'Next.js Skill installed',
  'MCP server available',
  'search_nextjs_manual available',
  'get_nextjs_manual available',
  'search_nextjs_api available',
];

const statusOf = (report: DoctorReport, id: string) =>
  report.checks.find((check) => check.id === id)?.status;

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

/** A project with everything in place: config, manuals, index and Skill. */
async function makeHealthyProject(): Promise<string> {
  const { root } = await makeIndexedProject({ constraint: '^16.1.0' });
  await installSkill({ root });
  return root;
}

describe('doctor on a healthy project', () => {
  it('passes every check', async () => {
    const report = await runDoctor(await makeHealthyProject());

    expect(report.ok).toBe(true);
    expect(report.checks.every((check) => check.status === 'ok')).toBe(true);
  });

  it('includes every public command in the report', async () => {
    const report = await runDoctor(await makeHealthyProject());

    expect(report.commands).toEqual(DOCTOR_COMMANDS);
    expect(report.commands.map((command) => command.command)).toEqual([
      'nextjs-harness setup',
      'nextjs-harness doctor',
      'nextjs-harness init',
      'nextjs-harness manuals sync',
      'nextjs-harness manuals index',
      'nextjs-harness manuals update',
      'nextjs-harness manuals search <query>',
      'nextjs-harness manuals status',
      'nextjs-harness manuals versions',
      'nextjs-harness specs index',
      'nextjs-harness specs search <query>',
      'nextjs-harness specs status',
      'nextjs-harness targets list',
      'nextjs-harness targets add <agent>',
      'nextjs-harness targets remove <agent>',
      'nextjs-harness targets install',
      'nextjs-harness skill install',
      'nextjs-harness skill update',
      'nextjs-harness agent install',
      'nextjs-harness agent update',
      'nextjs-harness mcp start',
      'nextjs-harness mcp status',
    ]);
  });

  it('reports the nine checks in the documented order', async () => {
    const report = await runDoctor(await makeHealthyProject());

    expect(report.checks).toHaveLength(9);
    expect(report.checks.map((check) => check.label.replace(/: .*$/, ''))).toEqual(EXPECTED_ORDER);
  });

  it('prints the expected ✓ lines', async () => {
    const root = await makeHealthyProject();
    const output = await capture(() => doctorCommand({ cwd: root }));

    expect(output).toContain('✓ Next.js project detected');
    expect(output).toContain('✓ Next.js version: 16.1');
    expect(output).toContain('✓ Manuals synchronized');
    expect(output).toContain('✓ Documentation index available');
    expect(output).toContain('✓ Next.js Skill installed');
    expect(output).toContain('✓ MCP server available');
    expect(output).toContain('✓ search_nextjs_manual available');
    expect(output).toContain('✓ get_nextjs_manual available');
    expect(output).toContain('✓ search_nextjs_api available');
    expect(output).toContain('Available commands:');
    expect(output).toContain('nextjs-harness setup');
    expect(output).toContain('nextjs-harness specs search <query>');
    expect(output).toContain('nextjs-harness mcp status');
    expect(output).not.toContain('✗');
  });

  it('leaves the exit code alone when healthy', async () => {
    const root = await makeHealthyProject();
    process.exitCode = undefined;

    await capture(() => doctorCommand({ cwd: root }));
    expect(process.exitCode).toBeUndefined();
  });

  it('emits machine-readable JSON', async () => {
    const root = await makeHealthyProject();
    const output = await capture(() => doctorCommand({ cwd: root, json: true }));
    const report = JSON.parse(output) as DoctorReport;

    expect(report.ok).toBe(true);
    expect(report.checks).toHaveLength(9);
    expect(report.commands).toEqual(DOCTOR_COMMANDS);
  });

  it('blames only search when hybrid is configured but not yet embedded', async () => {
    // doctor is the setup health check, so it has to point at the actual
    // problem. The index itself is fine and reading a document by id works;
    // only hybrid *search* is unusable until the corpus is embedded.
    const root = await makeHealthyProject();
    await updateConfig(root, (current) => ({
      ...current,
      index: { ...current.index, searchStrategy: 'hybrid' as const },
    }));
    resetConfigCache();

    const report = await runDoctor(root);

    expect(statusOf(report, 'index')).toBe('ok');
    expect(statusOf(report, 'tool:get_nextjs_manual')).toBe('ok');
    expect(statusOf(report, 'tool:search_nextjs_manual')).toBe('fail');

    const hint = report.checks.find((check) => check.id === 'tool:search_nextjs_manual')?.hint;
    expect(hint).toMatch(/not been fully indexed with embeddings/);
    expect(hint).toMatch(/nextjs-harness manuals update/);
  });
});

describe('doctor on a broken project', () => {
  it('fails the first check outside a Next.js project and skips the rest', async () => {
    const root = await makeProject({ nonNextJs: true });
    const report = await runDoctor(root);

    expect(report.ok).toBe(false);
    expect(statusOf(report, 'project')).toBe('fail');
    expect(report.checks).toHaveLength(9);
    expect(report.checks.slice(1).every((check) => check.status === 'skip')).toBe(true);
  });

  it('does not throw when there is no project — it reports', async () => {
    const root = await makeProject({ nonNextJs: true });
    await expect(runDoctor(root)).resolves.toBeDefined();
  });

  it('tells an uninitialised project to run setup', async () => {
    const root = await makeProject({ constraint: '^16.1.0' });
    const report = await runDoctor(root);

    expect(statusOf(report, 'project')).toBe('ok');
    expect(statusOf(report, 'version')).toBe('ok');
    expect(statusOf(report, 'manuals')).toBe('fail');
    expect(report.checks.find((check) => check.id === 'manuals')?.hint).toContain(
      'nextjs-harness setup',
    );
  });

  it('flags missing manuals and index but still starts the MCP server', async () => {
    const root = await makeProject({ constraint: '^16.1.0' });
    await runInit(root);
    const report = await runDoctor(root);

    expect(statusOf(report, 'manuals')).toBe('fail');
    expect(statusOf(report, 'index')).toBe('fail');
    // The server deliberately starts without an index so its tools can explain why.
    expect(statusOf(report, 'mcp')).toBe('ok');
    expect(statusOf(report, 'tool:search_nextjs_manual')).toBe('skip');
  });

  it('flags a missing Skill without affecting the other checks', async () => {
    const { root } = await makeIndexedProject({ constraint: '^16.1.0' });
    const report = await runDoctor(root);

    expect(statusOf(report, 'skill')).toBe('fail');
    expect(statusOf(report, 'index')).toBe('ok');
    expect(statusOf(report, 'tool:search_nextjs_manual')).toBe('ok');
    expect(report.ok).toBe(false);
  });

  it('catches version drift at the version check', async () => {
    const root = await makeHealthyProject();
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'acme-blog', dependencies: { next: '^15.4.0' } }, null, 2),
    );
    await rm(path.join(root, 'package-lock.json'), { force: true });
    resetConfigCache();

    const report = await runDoctor(root);

    expect(statusOf(report, 'version')).toBe('fail');
    expect(report.checks.find((check) => check.id === 'version')?.hint).toContain(
      'Refusing to use Next.js v16.3.8 documentation',
    );
    expect(statusOf(report, 'index')).toBe('skip');
  });

  it('fails when the index file has been deleted', async () => {
    const root = await makeHealthyProject();
    await rm(harnessPaths(root).indexFile, { force: true });

    const report = await runDoctor(root);

    expect(statusOf(report, 'index')).toBe('fail');
    expect(report.checks.find((check) => check.id === 'index')?.hint).toContain(
      'nextjs-harness manuals update',
    );
  });

  it('sets a non-zero exit code and explains what to do', async () => {
    const root = await makeProject({ nonNextJs: true });
    process.exitCode = undefined;

    const output = await capture(() => doctorCommand({ cwd: root }));

    expect(process.exitCode).toBe(1);
    expect(output).toContain('Some checks failed');
    process.exitCode = undefined;
  });

  it('collapses a repeated skip reason instead of printing it nine times', async () => {
    const root = await makeProject({ nonNextJs: true });
    const output = await capture(() => doctorCommand({ cwd: root }));

    expect(output.split('no Next.js project').length - 1).toBe(1);
    process.exitCode = undefined;
  });
});
