/**
 * `nextjs-harness doctor` — one command that answers "is this set up correctly?"
 *
 * Every check is performed for real rather than inferred: the MCP checks stand
 * up the actual server over an in-memory transport, list its tools, and invoke
 * them. A tool that is registered but returns an error (stale index, version
 * drift) is a broken tool, and doctor should say so.
 *
 * Nothing here throws. A diagnostic command that dies on the first problem is
 * useless precisely when it is needed, so failures are collected and reported.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { access } from 'node:fs/promises';
import path from 'node:path';

import { harnessPaths, requireNextJsProject } from '../nextjs/project.js';
import { loadConfig, reconcileConfig } from '../../generators/config-generator/config.js';
import { isHarnessError } from '../../errors.js';
import { openCorpus } from '../../rags/manuals/corpus.js';
import { readManualMeta } from '../../rags/manuals/downloader.js';
import { createMcpContext } from '../../mcp/context.js';
import { createServer } from '../../mcp/server.js';
import { skillDirFor } from '../../generators/skill/installer.js';
import { instructionsInstalled } from '../../generators/targets/instructions.js';
import { TARGETS } from '../../generators/targets/registry.js';
import type { TargetId } from '../../generators/targets/types.js';
import { logger } from '../../logger.js';

export type CheckStatus = 'ok' | 'fail' | 'skip';

export interface DoctorCheck {
  id: string;
  label: string;
  status: CheckStatus;
  hint?: string;
}

export interface DoctorCommandInfo {
  command: string;
  description: string;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  commands: DoctorCommandInfo[];
  ok: boolean;
}

const MCP_TOOLS = ['search_nextjs_manual', 'get_nextjs_manual', 'search_nextjs_api'] as const;

export const DOCTOR_COMMANDS: DoctorCommandInfo[] = [
  { command: 'nextjs-harness setup', description: 'Run the full idempotent setup flow' },
  { command: 'nextjs-harness doctor', description: 'Check setup health and list available commands' },
  { command: 'nextjs-harness init', description: 'Detect the project and create .nextjs-harness/' },
  { command: 'nextjs-harness manuals sync', description: 'Download the official Next.js manuals' },
  { command: 'nextjs-harness manuals index', description: 'Build the manual search index' },
  { command: 'nextjs-harness manuals update', description: 'Sync manuals and update the index' },
  { command: 'nextjs-harness manuals search <query>', description: 'Search the Next.js manuals' },
  { command: 'nextjs-harness manuals status', description: 'Show synchronized and indexed manual status' },
  { command: 'nextjs-harness manuals versions', description: 'List documentation lines and local status' },
  { command: 'nextjs-harness specs index', description: "Index this project's own specs" },
  { command: 'nextjs-harness specs search <query>', description: "Search this project's own specs" },
  { command: 'nextjs-harness specs status', description: 'Show project spec search status' },
  { command: 'nextjs-harness targets list', description: 'List coding agents and their setup state' },
  { command: 'nextjs-harness targets add <agent>', description: 'Set this project up for another coding agent' },
  { command: 'nextjs-harness targets remove <agent>', description: 'Stop maintaining files for a coding agent' },
  { command: 'nextjs-harness targets install', description: 'Reinstall files for every configured agent' },
  { command: 'nextjs-harness skill install', description: 'Install the Next.js guidance' },
  { command: 'nextjs-harness skill update', description: 'Update the Next.js guidance' },
  { command: 'nextjs-harness agent install', description: 'Install the Next.js roles' },
  { command: 'nextjs-harness agent update', description: 'Update the Next.js roles' },
  { command: 'nextjs-harness mcp start', description: 'Run the MCP server on stdio' },
  { command: 'nextjs-harness mcp status', description: 'Show MCP registration and readiness' },
];

function doctorReport(checks: DoctorCheck[]): DoctorReport {
  return {
    checks,
    commands: [...DOCTOR_COMMANDS],
    ok: checks.every((check) => check.status !== 'fail'),
  };
}

function messageOf(error: unknown): string {
  if (isHarnessError(error)) {
    return error.hint ? `${error.message}\n${error.hint}` : error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * The guidance check for one coding agent.
 *
 * Claude Code keeps the original id and label, because "Next.js Skill
 * installed" is what it has always been called and scripts read these ids.
 */
function guidanceCheck(target: TargetId): [string, string] {
  return target === 'claude-code'
    ? ['skill', 'Next.js Skill installed']
    : [`guidance:${target}`, `${TARGETS[target].label} guidance installed`];
}

export async function runDoctor(cwd: string = process.cwd()): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const add = (id: string, label: string, status: CheckStatus, hint?: string): void => {
    checks.push({ id, label, status, ...(hint ? { hint } : {}) });
  };

  // Which agents to report on. Assumes Claude Code until the config says
  // otherwise, so a project that cannot be read still produces a full report.
  let guidance: Array<[string, string]> = [guidanceCheck('claude-code')];

  /** Marks every remaining check as skipped, so the report stays complete. */
  const skipRest = (reason: string): DoctorReport => {
    const done = new Set(checks.map((check) => check.id));
    for (const [id, label] of [
      ['version', 'Next.js version'],
      ['manuals', 'Manuals synchronized'],
      ['index', 'Documentation index available'],
      ...guidance,
      ['mcp', 'MCP server available'],
      ...MCP_TOOLS.map((tool) => [`tool:${tool}`, `${tool} available`]),
    ] as Array<[string, string]>) {
      if (!done.has(id)) {
        add(id, label, 'skip', reason);
      }
    }
    return doctorReport(checks);
  };

  // 1. Project detection.
  let project;
  try {
    project = await requireNextJsProject(cwd);
    add('project', 'Next.js project detected', 'ok');
  } catch (error) {
    add('project', 'Next.js project detected', 'fail', messageOf(error));
    return skipRest('no Next.js project');
  }

  const paths = harnessPaths(project.root);

  // 2. Version, reconciled against the stored config so drift is caught here.
  let config = await loadConfig(project.root);
  if (!config) {
    add('version', `Next.js version: ${project.version.version}`, 'ok');
    add('manuals', 'Manuals synchronized', 'fail', 'Not initialised. Run: nextjs-harness setup');
    return skipRest('not initialised');
  }

  guidance = config.targets.map(guidanceCheck);

  try {
    config = await reconcileConfig(project.root, project.version, config);
    add('version', `Next.js version: ${config.nextjs.version}`, 'ok');
  } catch (error) {
    add('version', `Next.js version: ${project.version.version}`, 'fail', messageOf(error));
    return skipRest('Next.js version does not match the configuration');
  }

  const docsLine = config.nextjs.docsLine;

  // 3. Manuals on disk.
  const meta = await readManualMeta(paths.manualMetaFile(docsLine));
  if (meta && meta.fileCount > 0) {
    add('manuals', 'Manuals synchronized', 'ok');
  } else {
    add(
      'manuals',
      'Manuals synchronized',
      'fail',
      `No Next.js ${docsLine} manuals found. Run: nextjs-harness manuals update`,
    );
  }

  // 4. Index — opened for real, which is also what enforces version safety.
  let indexOk = false;
  // A document id taken straight from the corpus, so get_nextjs_manual can be
  // exercised even when search cannot run — reading a document by id does not
  // depend on search working, and under hybrid it may be the only one that does.
  let knownDocumentId: string | undefined;
  try {
    const corpus = await openCorpus({ root: project.root, config });
    indexOk = corpus.documentCount > 0;
    [knownDocumentId] = corpus.repository.hashesFor(corpus.docsLine, corpus.lang).keys();
    corpus.close();
    add('index', 'Documentation index available', indexOk ? 'ok' : 'fail');
  } catch (error) {
    add('index', 'Documentation index available', 'fail', messageOf(error));
  }

  // 5. Guidance, once per coding agent this project is set up for.
  for (const id of config.targets) {
    const [checkId, label] = guidanceCheck(id);
    const installed =
      id === 'claude-code'
        ? await exists(path.join(skillDirFor(project.root), 'SKILL.md'))
        : await instructionsInstalled(project.root, TARGETS[id]);

    if (installed) {
      add(checkId, label, 'ok');
    } else {
      add(
        checkId,
        label,
        'fail',
        id === 'claude-code'
          ? 'Run: nextjs-harness skill install'
          : `Run: nextjs-harness targets install --target ${id}`,
      );
    }
  }

  // 6-9. The MCP server and its tools, exercised rather than assumed.
  let client: Client | undefined;
  try {
    const server = createServer(createMcpContext(project.root));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'nextjs-harness-doctor', version: '1.0.0' });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    add('mcp', 'MCP server available', 'ok');
  } catch (error) {
    add('mcp', 'MCP server available', 'fail', messageOf(error));
    for (const tool of MCP_TOOLS) {
      add(`tool:${tool}`, `${tool} available`, 'skip', 'MCP server did not start');
    }
    return doctorReport(checks);
  }

  try {
    const { tools } = await client.listTools();
    const registered = new Set(tools.map((tool) => tool.name));

    // A documentId from a live search, so get_nextjs_manual can be exercised
    // with real input instead of one we know will fail. Falls back to an id
    // read directly from the corpus when search itself is unavailable.
    let documentId: string | undefined = knownDocumentId;
    if (indexOk && registered.has('search_nextjs_manual')) {
      const result = await client.callTool({
        name: 'search_nextjs_manual',
        arguments: { query: 'middleware', limit: 1 },
      });
      const structured = result.structuredContent as
        | { results?: Array<{ documentId?: string }> }
        | undefined;
      documentId = structured?.results?.[0]?.documentId ?? knownDocumentId;
    }

    for (const tool of MCP_TOOLS) {
      const id = `tool:${tool}`;
      const label = `${tool} available`;

      if (!registered.has(tool)) {
        add(id, label, 'fail', 'Tool is not registered by the MCP server');
        continue;
      }

      if (!indexOk) {
        add(id, label, 'skip', 'documentation index unavailable, tool not exercised');
        continue;
      }

      const args =
        tool === 'get_nextjs_manual'
          ? documentId
            ? { documentId }
            : undefined
          : { query: 'middleware', limit: 1 };

      if (!args) {
        add(id, label, 'skip', 'no document available to exercise the tool');
        continue;
      }

      try {
        const result = await client.callTool({ name: tool, arguments: args });
        if (result.isError) {
          const text = Array.isArray(result.content) ? result.content[0]?.text : undefined;
          add(id, label, 'fail', String(text ?? 'Tool returned an error'));
        } else {
          add(id, label, 'ok');
        }
      } catch (error) {
        add(id, label, 'fail', messageOf(error));
      }
    }
  } catch (error) {
    for (const tool of MCP_TOOLS) {
      add(`tool:${tool}`, `${tool} available`, 'fail', messageOf(error));
    }
  } finally {
    await client.close();
  }

  return doctorReport(checks);
}

export interface DoctorCommandOptions {
  cwd?: string;
  json?: boolean;
}

const SYMBOL: Record<CheckStatus, string> = { ok: '✓', fail: '✗', skip: '·' };

export async function doctorCommand(options: DoctorCommandOptions = {}): Promise<void> {
  const report = await runDoctor(options.cwd);

  if (options.json) {
    logger.print(JSON.stringify(report, null, 2));
  } else {
    // Skipped checks usually share one cause; printing it against every line
    // buries the actual failure, so consecutive repeats are collapsed.
    let lastSkipReason: string | undefined;

    for (const check of report.checks) {
      logger.print(`${SYMBOL[check.status]} ${check.label}`);

      if (!check.hint || check.status === 'ok') {
        continue;
      }
      if (check.status === 'skip') {
        if (check.hint === lastSkipReason) {
          continue;
        }
        lastSkipReason = check.hint;
      }

      for (const line of check.hint.split('\n')) {
        if (line.trim()) {
          logger.print(`    ${line.trim()}`);
        }
      }
    }

    logger.print();
    logger.print('Available commands:');
    for (const command of report.commands) {
      logger.print(`  ${command.command.padEnd(43)} ${command.description}`);
    }

    if (!report.ok) {
      logger.print();
      logger.print('Some checks failed. Fix the items above and re-run:');
      logger.print('  nextjs-harness doctor');
    }
  }

  if (!report.ok) {
    process.exitCode = 1;
  }
}
