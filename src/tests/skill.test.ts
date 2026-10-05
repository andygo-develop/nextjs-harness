import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { installSkill, skillDirFor } from '../generators/skill/installer.js';
import { listTemplateFiles, templateRoot } from '../generators/skill/templates.js';
import { MANIFEST_FILE } from '../generators/template-installer.js';
import { cleanupTempDirs, makeProject } from './helpers.js';

afterEach(cleanupTempDirs);

describe('skill templates', () => {
  it('ships a SKILL.md and the references the guidance is organised around', async () => {
    const files = await listTemplateFiles(templateRoot());

    expect(files).toContain('SKILL.md');
    expect(files.filter((file) => file.startsWith('references/')).sort()).toEqual([
      'references/architecture.md',
      'references/caching.md',
      'references/conventions.md',
      'references/data-fetching.md',
      'references/routing.md',
      'references/security.md',
      'references/testing.md',
    ]);
  });

  it('links every reference it ships, and ships every reference it links', async () => {
    const files = await listTemplateFiles(templateRoot());
    const shipped = files.filter((file) => file.startsWith('references/')).sort();
    const source = await readFile(path.join(templateRoot(), 'SKILL.md'), 'utf8');
    const linked = [...new Set(source.match(/references\/[\w-]+\.md/g))].sort();

    expect(linked).toEqual(shipped);
  });

  it('gives SKILL.md the front matter Claude Code needs', async () => {
    const source = await readFile(path.join(templateRoot(), 'SKILL.md'), 'utf8');

    expect(source.startsWith('---\n')).toBe(true);
    expect(source).toMatch(/^name:\s*nextjs$/m);
    expect(source).toMatch(/^description:\s*\S+/m);
  });

  it('instructs the agent to consult the MCP instead of guessing', async () => {
    const source = await readFile(path.join(templateRoot(), 'SKILL.md'), 'utf8');

    expect(source).toContain('search_nextjs_manual');
    expect(source).toContain('get_nextjs_manual');
    expect(source).toMatch(/prefer .*verified|verified .*over/i);
  });

  it('documents project spec search as separate from framework docs', async () => {
    const source = await readFile(path.join(templateRoot(), 'SKILL.md'), 'utf8');

    expect(source).toContain('search_project_specs');
    expect(source).toContain('get_project_spec');
    expect(source).toMatch(/Project specs are separate/i);
    expect(source).toMatch(/framework; project specs explain this application's intended behaviour/i);
  });

  it('keeps the Skill small rather than duplicating the manual', async () => {
    const files = await listTemplateFiles(templateRoot());
    let total = 0;
    for (const file of files) {
      total += (await readFile(path.join(templateRoot(), file), 'utf8')).length;
    }

    // The manual is megabytes; the Skill is guidance and must stay compact.
    expect(total).toBeLessThan(80_000);
  });
});

describe('skill installation', () => {
  it('installs into .claude/skills/nextjs', async () => {
    const root = await makeProject({ constraint: '^16.1.0' });
    const result = await installSkill({ root });

    expect(result.skillDir).toBe(skillDirFor(root));
    expect(result.added).toContain('SKILL.md');
    expect(result.added.some((file) => file.startsWith('references/'))).toBe(true);

    const installed = await readFile(path.join(result.skillDir, 'SKILL.md'), 'utf8');
    expect(installed).toContain('name: nextjs');
  });

  it('is idempotent — reinstalling changes nothing', async () => {
    const root = await makeProject({ constraint: '^16.1.0' });
    const first = await installSkill({ root });
    const second = await installSkill({ root });

    expect(second.added).toEqual([]);
    expect(second.updated).toEqual([]);
    expect(second.skipped).toEqual([]);
    expect(second.unchanged.length).toBe(first.added.length);
  });

  it('preserves a file the developer has edited', async () => {
    const root = await makeProject({ constraint: '^16.1.0' });
    await installSkill({ root });

    const skillFile = path.join(skillDirFor(root), 'SKILL.md');
    await writeFile(skillFile, '---\nname: nextjs\n---\n\nMy project-specific rules.\n', 'utf8');

    const result = await installSkill({ root });

    expect(result.skipped).toContain('SKILL.md');
    expect(await readFile(skillFile, 'utf8')).toContain('My project-specific rules.');
  });

  it('overwrites local edits when forced', async () => {
    const root = await makeProject({ constraint: '^16.1.0' });
    await installSkill({ root });

    const skillFile = path.join(skillDirFor(root), 'SKILL.md');
    await writeFile(skillFile, 'replaced\n', 'utf8');

    const result = await installSkill({ root, force: true });

    expect(result.updated).toContain('SKILL.md');
    expect(await readFile(skillFile, 'utf8')).toContain('name: nextjs');
  });

  /**
   * The manifest is what proves a file is ours. Without an entry for it, a file
   * already on disk is the developer's — they wrote it themselves, or the
   * manifest was lost — and overwriting it destroys work with no way back.
   */
  it('preserves a file it has no manifest entry for', async () => {
    const root = await makeProject({ constraint: '^16.1.0' });
    const skillFile = path.join(skillDirFor(root), 'SKILL.md');

    await mkdir(skillDirFor(root), { recursive: true });
    await writeFile(skillFile, 'Rules I wrote before ever running the installer.\n', 'utf8');

    const result = await installSkill({ root });

    expect(result.skipped).toContain('SKILL.md');
    expect(await readFile(skillFile, 'utf8')).toBe(
      'Rules I wrote before ever running the installer.\n',
    );
    // Everything it had not seen before is still installed normally.
    expect(result.added.some((file) => file.startsWith('references/'))).toBe(true);
  });

  it('preserves local edits when the manifest is lost', async () => {
    const root = await makeProject({ constraint: '^16.1.0' });
    await installSkill({ root });

    const skillFile = path.join(skillDirFor(root), 'SKILL.md');
    await writeFile(skillFile, 'my tuned guidance\n', 'utf8');
    await rm(path.join(skillDirFor(root), MANIFEST_FILE));

    const result = await installSkill({ root });

    expect(result.skipped).toContain('SKILL.md');
    expect(await readFile(skillFile, 'utf8')).toBe('my tuned guidance\n');
  });

  it('still overwrites an unrecorded file when forced', async () => {
    const root = await makeProject({ constraint: '^16.1.0' });
    const skillFile = path.join(skillDirFor(root), 'SKILL.md');

    await mkdir(skillDirFor(root), { recursive: true });
    await writeFile(skillFile, 'mine\n', 'utf8');

    const result = await installSkill({ root, force: true });

    expect(result.updated).toContain('SKILL.md');
    expect(await readFile(skillFile, 'utf8')).toContain('name: nextjs');
  });

  it('keeps treating a modified file as user-owned across repeated runs', async () => {
    const root = await makeProject({ constraint: '^16.1.0' });
    await installSkill({ root });

    const skillFile = path.join(skillDirFor(root), 'SKILL.md');
    await writeFile(skillFile, 'mine\n', 'utf8');

    await installSkill({ root });
    const third = await installSkill({ root });

    expect(third.skipped).toContain('SKILL.md');
    expect(await readFile(skillFile, 'utf8')).toBe('mine\n');
  });

  it('restores a file the developer deleted', async () => {
    const root = await makeProject({ constraint: '^16.1.0' });
    await installSkill({ root });

    const { rm } = await import('node:fs/promises');
    await rm(path.join(skillDirFor(root), 'references', 'data-fetching.md'));

    const result = await installSkill({ root });
    expect(result.added).toContain('references/data-fetching.md');
  });

  it('writes a manifest describing what it installed', async () => {
    const root = await makeProject({ constraint: '^16.1.0' });
    await installSkill({ root });

    const manifest = JSON.parse(
      await readFile(path.join(skillDirFor(root), '.nextjs-harness-manifest.json'), 'utf8'),
    );

    expect(manifest.templateSet).toBe('skill:nextjs');
    expect(Object.keys(manifest.files)).toContain('SKILL.md');
  });
});
