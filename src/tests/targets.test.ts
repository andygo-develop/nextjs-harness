/**
 * Coding-agent targets: detection, per-agent file layout, and MCP registration
 * in three configuration dialects.
 *
 * The load-bearing properties are that installing is idempotent, that a
 * developer's own files and edits survive it, and that a restriction expressed
 * for one agent (the reviewer cannot write) survives translation to another.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { AGENT_NAMES } from '../generators/agent/installer.js';
import { buildVersion } from '../cli/nextjs/version.js';
import { ensureConfig, loadConfig } from '../generators/config-generator/config.js';
import { installTarget, installTargets, targetManifestFile } from '../generators/targets/install.js';
import {
  fileCohort,
  instructionsBody,
  instructionsInstalled,
  SHARED_REFERENCES_DIR,
  SHARED_ROLES_DIR,
} from '../generators/targets/instructions.js';
import { findBlock, removeManagedBlock } from '../generators/targets/managed-block.js';
import { inspectTargetRegistration, registerTargetServer } from '../generators/targets/mcp.js';
import { opencodeTools, tomlString } from '../generators/targets/roles.js';
import { detectTargets, parseTargetIds, requireTarget, TARGETS } from '../generators/targets/registry.js';
import { TARGET_IDS, type TargetId } from '../generators/targets/types.js';
import { cleanupTempDirs, makeProject } from './helpers.js';

afterEach(cleanupTempDirs);

const v161 = buildVersion({ major: 16, minor: 1 }, 'package-lock.json', '16.1.4');

/** A project with a config, ready for target installation. */
async function makeConfigured(targets?: TargetId[]): Promise<string> {
  const root = await makeProject({ constraint: '^16.1.0' });
  await ensureConfig(root, v161, { targets });
  return root;
}

const install = (root: string, ids: TargetId[]) =>
  installTargets(ids, { root, serverName: 'nextjs-docs', cohort: ids });

const read = (root: string, file: string) => readFile(path.join(root, file), 'utf8');

const exists = async (root: string, file: string): Promise<boolean> => {
  try {
    await read(root, file);
    return true;
  } catch {
    return false;
  }
};

describe('the target registry', () => {
  it('describes every supported agent', () => {
    expect(TARGET_IDS.map((id) => TARGETS[id].id)).toEqual([...TARGET_IDS]);
    for (const id of TARGET_IDS) {
      expect(TARGETS[id].label).toBeTruthy();
      expect(TARGETS[id].mcp.file).toBeTruthy();
      expect(TARGETS[id].markers.length).toBeGreaterThan(0);
    }
  });

  it('rejects an unknown agent with the list of real ones', () => {
    expect(() => requireTarget('copilot')).toThrow(/Unknown coding agent "copilot"/);
    try {
      requireTarget('copilot');
    } catch (error) {
      expect((error as { hint?: string }).hint).toContain('claude-code');
    }
  });

  it('accepts repeated and comma-separated flags, dropping duplicates', () => {
    expect(parseTargetIds(['cursor,codex', 'cursor', ' gemini '])).toEqual([
      'cursor',
      'codex',
      'gemini',
    ]);
  });

  it('detects the agents a project already shows signs of', async () => {
    const root = await makeProject({ constraint: '^16.1.0' });
    await mkdir(path.join(root, '.cursor'), { recursive: true });
    await writeFile(path.join(root, 'opencode.json'), '{}');

    expect(await detectTargets(root)).toEqual(['cursor', 'opencode']);
  });

  it('detects nothing in a bare project', async () => {
    expect(await detectTargets(await makeProject({ constraint: '^16.1.0' }))).toEqual([]);
  });
});

describe('config targets', () => {
  it('defaults to Claude Code, so a config written before targets existed still works', async () => {
    const root = await makeProject({ constraint: '^16.1.0' });
    const { config } = await ensureConfig(root, v161);

    expect(config.targets).toEqual(['claude-code']);
  });

  it('records what was detected when the config is created', async () => {
    const root = await makeProject({ constraint: '^16.1.0' });
    const { config } = await ensureConfig(root, v161, { targets: ['cursor', 'gemini'] });

    expect(config.targets).toEqual(['cursor', 'gemini']);
    expect((await loadConfig(root))?.targets).toEqual(['cursor', 'gemini']);
  });

  it('refuses an unknown agent in the stored config', async () => {
    const root = await makeConfigured();
    const file = path.join(root, '.nextjs-harness', 'config.json');
    const raw = JSON.parse(await readFile(file, 'utf8'));
    await writeFile(file, JSON.stringify({ ...raw, targets: ['nonsuch'] }));
    await cleanupCache();

    await expect(loadConfig(root)).rejects.toThrow(/not valid/);
  });
});

/** The config module caches raw files by root; drop it between assertions. */
async function cleanupCache(): Promise<void> {
  const { resetConfigCache } = await import('../generators/config-generator/config.js');
  resetConfigCache();
}

describe('installing for Cursor', () => {
  it('writes a rule, commands and shared references', async () => {
    const root = await makeConfigured(['cursor']);
    await install(root, ['cursor']);

    const rule = await read(root, '.cursor/rules/nextjs.mdc');
    expect(rule.startsWith('---\n')).toBe(true);
    // Next.js code lives in .tsx/.jsx and .mdx as much as .ts.
    expect(rule).toMatch(/^globs: \*\*\/\*\.\{ts,tsx,js,jsx,mdx\}$/m);
    expect(rule).toContain('.cursor/mcp.json');

    for (const name of AGENT_NAMES) {
      expect(await exists(root, `.cursor/commands/${name}.md`)).toBe(true);
    }
    expect(await exists(root, `${SHARED_REFERENCES_DIR}/data-fetching.md`)).toBe(true);
  });

  it('points the guidance at the shared references, not at a Skill directory', async () => {
    const root = await makeConfigured(['cursor']);
    await install(root, ['cursor']);

    const rule = await read(root, '.cursor/rules/nextjs.mdc');
    expect(rule).toContain(`${SHARED_REFERENCES_DIR}/architecture.md`);
    expect(rule).not.toMatch(/`references\/architecture\.md`/);
  });

  it('does not leave SKILL.md at the project root', async () => {
    const root = await makeConfigured(['cursor']);
    await install(root, ['cursor']);

    expect(await exists(root, 'SKILL.md')).toBe(false);
  });
});

describe('installing for OpenCode', () => {
  it('writes subagents whose permissions match the Claude tool list', async () => {
    const root = await makeConfigured(['opencode']);
    await install(root, ['opencode']);

    const reviewer = await read(root, '.opencode/agent/nextjs-code-reviewer.md');
    expect(reviewer).toContain('mode: subagent');
    // The reviewer must not be able to rewrite the code it is reviewing,
    // whichever agent is running it.
    expect(reviewer).toMatch(/^ {2}write: false$/m);
    expect(reviewer).toMatch(/^ {2}edit: false$/m);
    expect(reviewer).toMatch(/^ {2}read: true$/m);

    // The expert writes code, so it keeps full access.
    const expert = await read(root, '.opencode/agent/nextjs-expert.md');
    expect(expert).toMatch(/^ {2}write: true$/m);
  });

  it('strips the Claude tool namespace, which OpenCode does not use', async () => {
    const root = await makeConfigured(['opencode']);
    await install(root, ['opencode']);

    const expert = await read(root, '.opencode/agent/nextjs-expert.md');
    expect(expert).toContain('`search_nextjs_manual`');
    expect(expert).not.toContain('mcp__');
  });

  it('maps an absent tools line to full access and a list to an allow-list', () => {
    expect(opencodeTools(undefined)).toMatchObject({ write: true, edit: true, bash: true });
    expect(opencodeTools(['Read', 'Grep', 'Glob', 'Bash'])).toMatchObject({
      read: true,
      bash: true,
      write: false,
      edit: false,
    });
  });
});

describe('installing for Gemini CLI', () => {
  it('writes namespaced commands as valid TOML', async () => {
    const root = await makeConfigured(['gemini']);
    await install(root, ['gemini']);

    const expert = await read(root, '.gemini/commands/nextjs/expert.toml');
    expect(expert.startsWith('description = "')).toBe(true);
    expect(expert).toContain('prompt = """');
    expect(expert.trimEnd().endsWith('"""')).toBe(true);
  });

  it('escapes backslashes and quotes for TOML basic strings', () => {
    // A TOML basic string would otherwise read `\U` as an invalid escape.
    expect(tomlString('C:\\Users\\dev')).toBe('C:\\\\Users\\\\dev');
    expect(tomlString('say "hi"')).toBe('say \\"hi\\"');
  });
});

describe('installing for Codex', () => {
  it('merges into AGENTS.md without disturbing what is already there', async () => {
    const root = await makeConfigured(['codex']);
    await writeFile(path.join(root, 'AGENTS.md'), '# Acme\n\nRun npm test.\n');

    await install(root, ['codex']);
    const agents = await read(root, 'AGENTS.md');

    expect(agents).toContain('Run npm test.');
    expect(agents.indexOf('Run npm test.')).toBeLessThan(agents.indexOf('BEGIN nextjs-harness'));
    expect(findBlock(agents)).toBeDefined();
  });

  it('creates AGENTS.md when the project has none', async () => {
    const root = await makeConfigured(['codex']);
    await install(root, ['codex']);

    expect(findBlock(await read(root, 'AGENTS.md'))).toBeDefined();
  });

  it('installs the roles as playbooks and says they are not subagents', async () => {
    const root = await makeConfigured(['codex']);
    const [result] = await install(root, ['codex']);

    expect(result!.roles.unsupported).toBe(true);
    for (const name of AGENT_NAMES) {
      expect(await exists(root, `${SHARED_ROLES_DIR}/${name}.md`)).toBe(true);
    }
    expect(await read(root, 'AGENTS.md')).toContain(SHARED_ROLES_DIR);
  });
});

describe('AGENTS.md shared by two agents', () => {
  it('writes one block describing both, not two that overwrite each other', async () => {
    const root = await makeConfigured(['codex', 'opencode']);
    await install(root, ['codex', 'opencode']);

    const agents = await read(root, 'AGENTS.md');
    expect(agents.match(/BEGIN nextjs-harness/g)).toHaveLength(1);
    expect(agents).toContain('**OpenAI Codex CLI**');
    expect(agents).toContain('**OpenCode**');
  });

  it('is idempotent — the second agent does not rewrite the first agent’s block', async () => {
    const root = await makeConfigured(['codex', 'opencode']);
    await install(root, ['codex', 'opencode']);
    const results = await install(root, ['codex', 'opencode']);

    for (const result of results) {
      const block = result.instructions.files.find((file) => file.file === 'AGENTS.md');
      expect(block?.status).toBe('unchanged');
    }
  });

  it('keeps the block stable when only one of the two is reinstalled', async () => {
    const root = await makeConfigured(['codex', 'opencode']);
    await install(root, ['codex', 'opencode']);
    const before = await read(root, 'AGENTS.md');

    // `--target codex` on a project also set up for OpenCode.
    await installTargets(['codex'], {
      root,
      serverName: 'nextjs-docs',
      cohort: ['codex', 'opencode'],
    });

    expect(await read(root, 'AGENTS.md')).toBe(before);
  });

  it('resolves the cohort in registry order, whatever order install happens in', () => {
    const cohort = fileCohort(TARGETS.opencode, ['opencode', 'codex']);
    expect(cohort.map((target) => target.id)).toEqual(['codex', 'opencode']);
  });
});

describe('preserving the developer’s work', () => {
  it('keeps a locally edited rule file', async () => {
    const root = await makeConfigured(['cursor']);
    await install(root, ['cursor']);
    await writeFile(path.join(root, '.cursor/rules/nextjs.mdc'), 'my own rules\n');

    const [result] = await install(root, ['cursor']);

    expect(result!.instructions.files).toContainEqual({
      file: '.cursor/rules/nextjs.mdc',
      status: 'skipped',
    });
    expect(await read(root, '.cursor/rules/nextjs.mdc')).toBe('my own rules\n');
  });

  it('keeps a locally edited AGENTS.md block', async () => {
    const root = await makeConfigured(['codex']);
    await install(root, ['codex']);

    const edited = (await read(root, 'AGENTS.md')).replace(
      '# Next.js Development',
      '# Next.js Development\n\nOur own extra rule.',
    );
    await writeFile(path.join(root, 'AGENTS.md'), edited);

    const [result] = await install(root, ['codex']);

    expect(result!.instructions.files).toContainEqual({ file: 'AGENTS.md', status: 'skipped' });
    expect(await read(root, 'AGENTS.md')).toContain('Our own extra rule.');
  });

  it('overwrites an edited block only when forced', async () => {
    const root = await makeConfigured(['codex']);
    await install(root, ['codex']);
    await writeFile(
      path.join(root, 'AGENTS.md'),
      '<!-- BEGIN nextjs-harness -->\nmine\n<!-- END nextjs-harness -->\n',
    );

    await installTarget(TARGETS.codex, { root, serverName: 'nextjs-docs', force: true });

    expect(await read(root, 'AGENTS.md')).toContain('# Next.js Development');
  });

  it('leaves other agents’ files alone', async () => {
    const root = await makeConfigured(['opencode']);
    await mkdir(path.join(root, '.opencode', 'agent'), { recursive: true });
    await writeFile(path.join(root, '.opencode/agent/my-agent.md'), 'not ours\n');

    await install(root, ['opencode']);

    expect(await read(root, '.opencode/agent/my-agent.md')).toBe('not ours\n');
  });

  it('keeps its bookkeeping out of the project’s own directories', async () => {
    const root = await makeConfigured(['cursor']);
    await install(root, ['cursor']);

    expect(await exists(root, '.cursor/.nextjs-harness-manifest.json')).toBe(false);
    expect(await exists(root, '.nextjs-harness/targets/cursor.json')).toBe(true);
    expect(targetManifestFile(root, 'cursor')).toBe(
      path.join(root, '.nextjs-harness', 'targets', 'cursor.json'),
    );
  });

  it('removes only its own block from a shared file', async () => {
    const root = await makeConfigured(['codex']);
    await writeFile(path.join(root, 'AGENTS.md'), '# Acme\n\nHouse rules.\n');
    await install(root, ['codex']);

    expect(await removeManagedBlock(root, 'AGENTS.md')).toBe(true);

    const agents = await read(root, 'AGENTS.md');
    expect(agents).toContain('House rules.');
    expect(findBlock(agents)).toBeUndefined();
  });
});

describe('MCP registration per agent', () => {
  it.each([
    ['cursor', '.cursor/mcp.json'],
    ['gemini', '.gemini/settings.json'],
    ['claude-code', '.mcp.json'],
  ] as const)('registers %s in %s under mcpServers', async (id, file) => {
    const root = await makeConfigured([id]);
    const result = await registerTargetServer(root, TARGETS[id], 'nextjs-docs');

    expect(result.changed).toBe(true);
    const config = JSON.parse(await read(root, file));
    expect(config.mcpServers['nextjs-docs']).toEqual({
      command: 'npx',
      args: ['-y', '@andygo.dev/nextjs-harness', 'mcp', 'start'],
    });
  });

  it('registers OpenCode with a single command array', async () => {
    const root = await makeConfigured(['opencode']);
    await registerTargetServer(root, TARGETS.opencode, 'nextjs-docs');

    const config = JSON.parse(await read(root, 'opencode.json'));
    expect(config.mcp['nextjs-docs']).toEqual({
      type: 'local',
      command: ['npx', '-y', '@andygo.dev/nextjs-harness', 'mcp', 'start'],
      enabled: true,
    });
    expect(config.$schema).toBe('https://opencode.ai/config.json');
  });

  it('registers Codex as a TOML table', async () => {
    const root = await makeConfigured(['codex']);
    await registerTargetServer(root, TARGETS.codex, 'nextjs-docs');

    const toml = await read(root, '.codex/config.toml');
    expect(toml).toContain('[mcp_servers.nextjs-docs]');
    expect(toml).toContain('command = "npx"');
    expect(toml).toContain('args = ["-y", "@andygo.dev/nextjs-harness", "mcp", "start"]');
  });

  it('appends to an existing Codex config without touching what is there', async () => {
    const root = await makeConfigured(['codex']);
    await mkdir(path.join(root, '.codex'), { recursive: true });
    await writeFile(path.join(root, '.codex/config.toml'), 'model = "o3"\n\n[mcp_servers.other]\ncommand = "x"\n');

    await registerTargetServer(root, TARGETS.codex, 'nextjs-docs');
    const toml = await read(root, '.codex/config.toml');

    expect(toml).toContain('model = "o3"');
    expect(toml).toContain('[mcp_servers.other]');
    expect(toml).toContain('[mcp_servers.nextjs-docs]');
  });

  it('sees other servers already configured in each dialect', async () => {
    const root = await makeConfigured(['codex']);
    await mkdir(path.join(root, '.codex'), { recursive: true });
    await writeFile(path.join(root, '.codex/config.toml'), '[mcp_servers.other]\ncommand = "x"\n');

    const state = await inspectTargetRegistration(root, TARGETS.codex, 'nextjs-docs');
    expect(state).toMatchObject({ fileExists: true, registered: false });
    expect(state.otherServers).toEqual(['other']);
  });

  it.each(TARGET_IDS)('is idempotent for %s', async (id) => {
    const root = await makeConfigured([id]);
    await registerTargetServer(root, TARGETS[id], 'nextjs-docs');
    const second = await registerTargetServer(root, TARGETS[id], 'nextjs-docs');

    expect(second.changed).toBe(false);
    expect(second.registered).toBe(true);
  });

  it('leaves a customised entry alone', async () => {
    const root = await makeConfigured(['cursor']);
    await mkdir(path.join(root, '.cursor'), { recursive: true });
    await writeFile(
      path.join(root, '.cursor/mcp.json'),
      JSON.stringify({ mcpServers: { 'nextjs-docs': { command: 'node', args: ['mine.js'] } } }),
    );

    const result = await registerTargetServer(root, TARGETS.cursor, 'nextjs-docs');

    expect(result.changed).toBe(false);
    expect(result.current).toBe(false);
    expect(JSON.parse(await read(root, '.cursor/mcp.json')).mcpServers['nextjs-docs'].command).toBe(
      'node',
    );
  });
});

describe('the two corpora stay separate', () => {
  it('excludes every agent’s installed guidance from project spec discovery', async () => {
    const root = await makeConfigured(['codex', 'gemini', 'cursor', 'opencode']);
    await install(root, ['codex', 'gemini', 'cursor', 'opencode']);
    const config = (await loadConfig(root))!;

    const { discoverSpecFiles } = await import('../rags/specs/discovery.js');
    const { files } = await discoverSpecFiles({
      root,
      include: config.specs.include,
      exclude: config.specs.exclude,
    });

    // Framework guidance must never come back out of `search_project_specs`
    // looking like this project's own requirements.
    expect(files).not.toContain('AGENTS.md');
    expect(files).not.toContain('GEMINI.md');
    expect(files.filter((file) => file.startsWith('.'))).toEqual([]);
  });

  it('still indexes the project’s own documentation', async () => {
    const root = await makeConfigured(['codex']);
    await install(root, ['codex']);
    await mkdir(path.join(root, 'docs'), { recursive: true });
    await writeFile(path.join(root, 'docs/billing.md'), '# Billing\n\nInvoice rules.\n');

    const config = (await loadConfig(root))!;
    const { discoverSpecFiles } = await import('../rags/specs/discovery.js');
    const { files } = await discoverSpecFiles({
      root,
      include: config.specs.include,
      exclude: config.specs.exclude,
    });

    expect(files).toContain('docs/billing.md');
  });
});

describe('doctor’s view of a target', () => {
  it('reports guidance as missing until it is installed', async () => {
    const root = await makeConfigured(['cursor']);
    expect(await instructionsInstalled(root, TARGETS.cursor)).toBe(false);

    await install(root, ['cursor']);
    expect(await instructionsInstalled(root, TARGETS.cursor)).toBe(true);
  });

  it('does not count a project’s own AGENTS.md as our guidance', async () => {
    const root = await makeConfigured(['codex']);
    await writeFile(path.join(root, 'AGENTS.md'), '# Acme\n');

    expect(await instructionsInstalled(root, TARGETS.codex)).toBe(false);
  });
});

describe('rendering guidance for one agent', () => {
  const source = '---\nname: nextjs\ndescription: d\n---\n\n# Next.js Development\n\nSee `references/data-fetching.md`.\n';

  it('names the agent’s own MCP config file', () => {
    const body = instructionsBody(source, [TARGETS.cursor], 'my-docs');

    expect(body).toContain('`my-docs` MCP server');
    expect(body).toContain('`.cursor/mcp.json`');
    expect(body).toContain(`${SHARED_REFERENCES_DIR}/data-fetching.md`);
  });

  it('lists every agent that reads a shared file', () => {
    const body = instructionsBody(source, [TARGETS.codex, TARGETS.opencode], 'nextjs-docs');

    expect(body).toContain('`.codex/config.toml` and `opencode.json`');
    expect(body).toContain('OpenAI Codex CLI / OpenCode');
  });
});
