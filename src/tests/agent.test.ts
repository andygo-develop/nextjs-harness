import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { AGENT_NAMES, agentsDirFor, installAgents } from '../generators/agent/installer.js';
import { listTemplateFiles, packageTemplateDir, render } from '../generators/template-installer.js';
import { cleanupTempDirs, makeProject } from './helpers.js';

afterEach(cleanupTempDirs);

const agentFile = (root: string) => path.join(agentsDirFor(root), 'nextjs-expert.md');

const readAgentTemplate = (file: string) =>
  readFile(path.join(packageTemplateDir('agent'), file), 'utf8');

const AGENT_FILES = [
  'nextjs-expert.md',
  'nextjs-code-reviewer.md',
  'nextjs-test-writer.md',
  'nextjs-planner.md',
];

describe('agent templates', () => {
  it('keeps AGENT_NAMES in step with the shipped templates', async () => {
    const files = await listTemplateFiles(packageTemplateDir('agent'));

    expect(files.sort()).toEqual([...AGENT_NAMES].map((name) => `${name}.md`).sort());
  });

  it.each(AGENT_FILES)('%s has the front matter Claude Code needs', async (file) => {
    const source = await readAgentTemplate(file);

    expect(source.startsWith('---\n')).toBe(true);
    expect(source).toMatch(new RegExp(`^name:\\s*${path.basename(file, '.md')}$`, 'm'));
    expect(source).toMatch(/^description:\s*\S+/m);
    expect(source).toMatch(/^model:\s*\w+$/m);
  });

  it.each(AGENT_FILES)('%s references all three MCP tools via the placeholder', async (file) => {
    const source = await readAgentTemplate(file);

    for (const tool of ['search_nextjs_manual', 'get_nextjs_manual', 'search_nextjs_api']) {
      expect(source).toContain(`mcp__{{MCP_SERVER}}__${tool}`);
    }
  });

  it.each(AGENT_FILES)(
    '%s can search and fetch project specs, when available',
    async (file) => {
      const source = await readAgentTemplate(file);

      for (const tool of ['search_project_specs', 'get_project_spec']) {
        expect(source).toContain(`mcp__{{MCP_SERVER}}__${tool}`);
      }
      expect(source).toMatch(/project specs/i);
    },
  );

  it.each(AGENT_FILES)('%s tells the agent not to assert unverified APIs', async (file) => {
    const source = await readAgentTemplate(file);

    expect(source).toContain('nextjs-harness manuals update');
    expect(source).toMatch(/documentation wins|do not assume it exists/i);
  });

  it('lets nextjs-expert use every tool, since it writes code', async () => {
    const source = await readAgentTemplate('nextjs-expert.md');
    const frontMatter = /^---\n([\s\S]*?)\n---/.exec(source)![1]!;

    expect(frontMatter).not.toMatch(/^tools:/m);
  });

  it('restricts nextjs-code-reviewer to read-only tools plus the MCP lookups', async () => {
    const source = await readAgentTemplate('nextjs-code-reviewer.md');
    const frontMatter = /^---\n([\s\S]*?)\n---/.exec(source)![1]!;
    const tools = /^tools:\s*(.+)$/m.exec(frontMatter)![1]!.split(',').map((tool) => tool.trim());

    // A reviewer must not be able to rewrite the code it is reviewing.
    expect(tools).not.toContain('Edit');
    expect(tools).not.toContain('Write');
    expect(tools).toContain('Read');
    expect(tools).toContain('Grep');
    expect(tools).toEqual(
      expect.arrayContaining([
        'mcp__{{MCP_SERVER}}__search_nextjs_manual',
        'mcp__{{MCP_SERVER}}__get_nextjs_manual',
        'mcp__{{MCP_SERVER}}__search_nextjs_api',
        'mcp__{{MCP_SERVER}}__search_project_specs',
        'mcp__{{MCP_SERVER}}__get_project_spec',
      ]),
    );
  });

  it('gives the reviewer a severity scheme and Next.js-specific checks', async () => {
    const source = await readAgentTemplate('nextjs-code-reviewer.md');

    for (const term of [
      'Critical',
      'Warning',
      'Suggestion',
      "'use client'",
      'server-only',
      'NEXT_PUBLIC_',
      'Server Action',
      'dangerouslySetInnerHTML',
      'revalidateTag',
    ]) {
      expect(source).toContain(term);
    }
  });

  it('lets the test writer create files but forbids editing code under test', async () => {
    const source = await readAgentTemplate('nextjs-test-writer.md');
    const frontMatter = /^---\n([\s\S]*?)\n---/.exec(source)![1]!;
    const tools = /^tools:\s*(.+)$/m.exec(frontMatter)![1]!.split(',').map((tool) => tool.trim());

    expect(tools).toEqual(expect.arrayContaining(['Read', 'Write', 'Edit', 'Bash']));
    expect(tools).toEqual(
      expect.arrayContaining([
        'mcp__{{MCP_SERVER}}__search_project_specs',
        'mcp__{{MCP_SERVER}}__get_project_spec',
      ]),
    );
    // The guardrail is behavioural, since tool permissions cannot scope by path.
    expect(source).toMatch(/Never change production code to make a test pass/i);
    expect(source).toMatch(/Never claim a test passes without running it/i);
  });

  it('restricts nextjs-planner to read-only planning tools plus MCP lookups', async () => {
    const source = await readAgentTemplate('nextjs-planner.md');
    const frontMatter = /^---\n([\s\S]*?)\n---/.exec(source)![1]!;
    const tools = /^tools:\s*(.+)$/m.exec(frontMatter)![1]!.split(',').map((tool) => tool.trim());

    expect(tools).not.toContain('Edit');
    expect(tools).not.toContain('Write');
    expect(tools).toEqual(expect.arrayContaining(['Read', 'Grep', 'Glob', 'Bash']));
    expect(tools).toEqual(
      expect.arrayContaining([
        'mcp__{{MCP_SERVER}}__search_project_specs',
        'mcp__{{MCP_SERVER}}__get_project_spec',
      ]),
    );
    expect(source).toMatch(/You plan\. You do not edit files\./i);
    expect(source).toContain('Implementation steps');
    expect(source).toContain('Risks and open questions');
  });

  it('points the test writer at the real Next.js testing APIs', async () => {
    const source = await readAgentTemplate('nextjs-test-writer.md');

    for (const term of [
      'Vitest',
      'React Testing Library',
      'Playwright',
      'npm test',
      'next/headers',
      'next/navigation',
      'revalidatePath',
    ]) {
      expect(source).toContain(term);
    }
  });
});

describe('placeholder rendering', () => {
  it('substitutes known tokens', () => {
    expect(render('mcp__{{MCP_SERVER}}__search', { MCP_SERVER: 'nextjs-docs' })).toBe(
      'mcp__nextjs-docs__search',
    );
  });

  it('leaves unknown tokens untouched rather than blanking them', () => {
    expect(render('{{UNKNOWN}} stays', { MCP_SERVER: 'x' })).toBe('{{UNKNOWN}} stays');
  });
});

describe('agent installation', () => {
  it('installs every agent into .claude/agents', async () => {
    const root = await makeProject({ constraint: '^16.1.0' });
    const result = await installAgents({ root });

    expect(result.added.sort()).toEqual([...AGENT_FILES].sort());

    for (const file of AGENT_FILES) {
      const installed = await readFile(path.join(agentsDirFor(root), file), 'utf8');
      expect(installed).toContain(`name: ${path.basename(file, '.md')}`);
    }
  });

  it('renders the server name into the reviewer’s restricted tool list', async () => {
    const root = await makeProject({ constraint: '^16.1.0' });
    await installAgents({ root, mcpServerName: 'next-manual' });

    const reviewer = await readFile(path.join(agentsDirFor(root), 'nextjs-code-reviewer.md'), 'utf8');
    expect(reviewer).toContain('tools: Read, Grep, Glob, Bash, mcp__next-manual__search_nextjs_manual');
    expect(reviewer).not.toContain('{{MCP_SERVER}}');
  });

  it('bakes the default MCP server name into the tool references', async () => {
    const root = await makeProject({ constraint: '^16.1.0' });
    await installAgents({ root });

    const installed = await readFile(agentFile(root), 'utf8');
    expect(installed).toContain('mcp__nextjs-docs__search_nextjs_manual');
    expect(installed).not.toContain('{{MCP_SERVER}}');
  });

  it('honours a custom MCP server name', async () => {
    const root = await makeProject({ constraint: '^16.1.0' });
    await installAgents({ root, mcpServerName: 'my-next-docs' });

    const installed = await readFile(agentFile(root), 'utf8');
    expect(installed).toContain('mcp__my-next-docs__get_nextjs_manual');
    expect(installed).not.toContain('nextjs-docs__');
  });

  it('is idempotent', async () => {
    const root = await makeProject({ constraint: '^16.1.0' });
    await installAgents({ root });
    const second = await installAgents({ root });

    expect(second.added).toEqual([]);
    expect(second.updated).toEqual([]);
    expect(second.skipped).toEqual([]);
    expect(second.unchanged).toContain('nextjs-expert.md');
  });

  it('treats a changed server name as a normal update, not a local edit', async () => {
    const root = await makeProject({ constraint: '^16.1.0' });
    await installAgents({ root, mcpServerName: 'nextjs-docs' });

    const renamed = await installAgents({ root, mcpServerName: 'renamed-docs' });

    expect(renamed.updated).toContain('nextjs-expert.md');
    expect(renamed.skipped).toEqual([]);
    expect(await readFile(agentFile(root), 'utf8')).toContain('mcp__renamed-docs__');
  });

  it('preserves a locally customised agent', async () => {
    const root = await makeProject({ constraint: '^16.1.0' });
    await installAgents({ root });
    await writeFile(agentFile(root), '---\nname: nextjs-expert\n---\n\nMy own rules.\n', 'utf8');

    const result = await installAgents({ root });

    expect(result.skipped).toContain('nextjs-expert.md');
    expect(await readFile(agentFile(root), 'utf8')).toContain('My own rules.');
  });

  it('overwrites local edits when forced', async () => {
    const root = await makeProject({ constraint: '^16.1.0' });
    await installAgents({ root });
    await writeFile(agentFile(root), 'replaced\n', 'utf8');

    const result = await installAgents({ root, force: true });

    expect(result.updated).toContain('nextjs-expert.md');
    expect(await readFile(agentFile(root), 'utf8')).toContain('name: nextjs-expert');
  });

  it('restores a deleted agent file', async () => {
    const root = await makeProject({ constraint: '^16.1.0' });
    await installAgents({ root });
    await rm(agentFile(root));

    expect((await installAgents({ root })).added).toContain('nextjs-expert.md');
  });

  it('keeps its manifest out of the way of other tools’ agents', async () => {
    const root = await makeProject({ constraint: '^16.1.0' });
    // An agent installed by something else must survive untouched.
    const otherAgent = path.join(agentsDirFor(root), 'someone-elses-agent.md');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(agentsDirFor(root), { recursive: true });
    await writeFile(otherAgent, '---\nname: someone-elses-agent\n---\n\nNot ours.\n', 'utf8');

    await installAgents({ root });

    expect(await readFile(otherAgent, 'utf8')).toContain('Not ours.');

    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(agentsDirFor(root));
    // Only our agent plus a namespaced dotfile manifest are added.
    expect(entries.filter((entry) => entry.endsWith('.md')).sort()).toEqual(
      [...AGENT_FILES, 'someone-elses-agent.md'].sort(),
    );
    expect(entries).toContain('.nextjs-harness-agents.json');
  });
});
