/**
 * Shared installer for the template sets this package ships (the Skill and the
 * agent definition).
 *
 * Installation is idempotent and non-destructive. A manifest records the hash
 * of every file as written, which lets a later run tell three cases apart:
 *
 *   - file matches the template            → nothing to do
 *   - file matches the manifest            → untouched by the user, safe to update
 *   - file matches neither                 → locally edited, left alone
 *
 * That last case is the important one: a developer who has tuned a Skill or an
 * agent for their project should never lose that work to a routine update. It
 * is deliberately the default for anything unrecognised, including a file the
 * manifest has never heard of — writing over that is indistinguishable, from
 * the developer's side, from the tool eating their work.
 */
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { HarnessError } from '../errors.js';

export const MANIFEST_FILE = '.nextjs-harness-manifest.json';

export interface TemplateInstallResult {
  targetDir: string;
  added: string[];
  updated: string[];
  unchanged: string[];
  /** Locally modified files that were preserved rather than overwritten. */
  skipped: string[];
}

export interface Manifest {
  templateSet: string;
  installedAt: string;
  files: Record<string, string>;
}

export function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 40);
}

/** Reads a manifest, treating "missing" and "corrupt" alike as "not recorded". */
export async function readManifest(manifestFile: string): Promise<Manifest | undefined> {
  try {
    return JSON.parse(await readFile(manifestFile, 'utf8')) as Manifest;
  } catch {
    return undefined;
  }
}

/**
 * Writes a manifest, merging into whatever is already recorded.
 *
 * A target's files are written by several passes (instructions, roles) that
 * share one manifest, so a pass must add its own entries without forgetting the
 * others — otherwise the next run would read a file it wrote as a local edit.
 */
export async function writeManifest(
  manifestFile: string,
  templateSet: string,
  files: Record<string, string>,
): Promise<void> {
  const previous = await readManifest(manifestFile);
  const manifest: Manifest = {
    templateSet,
    installedAt: new Date().toISOString(),
    files: { ...(previous?.files ?? {}), ...files },
  };

  await mkdir(path.dirname(manifestFile), { recursive: true });
  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

/**
 * Absolute path to a directory under `src/generators/templates/` in the
 * installed package.
 *
 * Templates are Markdown, so they are not compiled — they ship straight from
 * the source tree (see `files` in package.json) and stay at
 * `src/generators/templates` whether the caller is the built `dist/` code or
 * the TypeScript sources under test. Both live two levels below the package
 * root, so the same relative walk works in either case.
 */
export function packageTemplateDir(...segments: string[]): string {
  // dist/generators/… or src/generators/… -> package root is two levels up.
  const packageRoot = fileURLToPath(new URL('../..', import.meta.url));
  return path.join(packageRoot, 'src', 'generators', 'templates', ...segments);
}

/** Lists template files relative to the template root, in a stable order. */
export async function listTemplateFiles(root: string, prefix = ''): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(path.join(root, prefix), { withFileTypes: true });
  } catch (cause) {
    throw new HarnessError('The bundled nextjs-harness templates could not be found.', {
      hint: `Expected them at:\n\n  ${root}\n\nReinstall the package with:\n\n  npm install -g nextjs-harness`,
      cause,
    });
  }

  const files: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      files.push(...(await listTemplateFiles(root, relative)));
    } else if (entry.isFile()) {
      files.push(relative);
    }
  }

  return files;
}

export async function readTemplate(root: string, relativePath: string): Promise<string> {
  return readFile(path.join(root, relativePath), 'utf8');
}

/**
 * Substitutes `{{TOKEN}}` placeholders.
 *
 * Rendering happens before hashing, so the manifest records what was actually
 * written. Changing a substituted value (for example renaming the MCP server)
 * therefore shows up as a normal template update rather than as a local edit.
 */
export function render(content: string, replacements: Record<string, string> = {}): string {
  return content.replace(/\{\{(\w+)\}\}/g, (match, token: string) =>
    Object.hasOwn(replacements, token) ? replacements[token]! : match,
  );
}

/** A template rewritten for one target: where it lands, and what it says. */
export interface TemplateOutput {
  /** Path relative to `targetDir`. */
  path: string;
  content: string;
}

/**
 * Rewrites a template for a particular coding agent.
 *
 * Runs on the *raw* template, before `{{TOKEN}}` substitution, so a transform
 * can rewrite the placeholders themselves — non-Claude tools expose MCP tools
 * under plain names rather than `mcp__<server>__<tool>`. Returning `undefined`
 * drops the template for this target.
 */
export type TemplateTransform = (
  relativePath: string,
  content: string,
) => TemplateOutput | undefined;

export interface InstallTemplateSetOptions {
  /** Directory holding the templates, inside the package. */
  sourceDir: string;
  /** Directory to install into. */
  targetDir: string;
  /** Where the manifest lives (defaults to `<targetDir>/<MANIFEST_FILE>`). */
  manifestFile?: string;
  /** Name recorded in the manifest, for diagnostics. */
  templateSet: string;
  /** `{{TOKEN}}` values substituted into every template. */
  replacements?: Record<string, string>;
  /** Only install these template-relative paths (defaults to all). */
  only?: readonly string[];
  /** Rewrites each template's destination and content for one target. */
  transform?: TemplateTransform;
  /** Overwrite locally modified files. */
  force?: boolean;
}

export async function installTemplateSet(
  options: InstallTemplateSetOptions,
): Promise<TemplateInstallResult> {
  const manifestFile = options.manifestFile ?? path.join(options.targetDir, MANIFEST_FILE);
  const all = await listTemplateFiles(options.sourceDir);
  const templates = options.only ? all.filter((file) => options.only!.includes(file)) : all;

  const manifest = await readManifest(manifestFile);

  const result: TemplateInstallResult = {
    targetDir: options.targetDir,
    added: [],
    updated: [],
    unchanged: [],
    skipped: [],
  };
  const nextFiles: Record<string, string> = {};

  for (const source of templates) {
    const raw = await readTemplate(options.sourceDir, source);
    // Not `?? default`: a transform returning undefined means "drop this
    // template", and `??` would quietly turn that into "install it unchanged".
    const rewritten = options.transform
      ? options.transform(source, raw)
      : { path: source, content: raw };

    if (!rewritten) {
      continue;
    }

    // Everything downstream is keyed by where the file actually lands, so a
    // renamed template is tracked as the file on disk rather than its origin.
    const relative = rewritten.path;
    const content = render(rewritten.content, options.replacements);
    const templateHash = hashContent(content);
    const target = path.join(options.targetDir, relative);

    let current: string | undefined;
    try {
      current = await readFile(target, 'utf8');
    } catch {
      current = undefined;
    }

    if (current === undefined) {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content, 'utf8');
      result.added.push(relative);
      nextFiles[relative] = templateHash;
      continue;
    }

    const currentHash = hashContent(current);

    if (currentHash === templateHash) {
      result.unchanged.push(relative);
      nextFiles[relative] = templateHash;
      continue;
    }

    const recordedHash = manifest?.files[relative];
    // Anything on disk that we cannot prove we wrote is the developer's. That
    // includes a file with no manifest entry at all: it means either they
    // created it themselves, or the manifest was lost — and in both cases
    // overwriting is the one outcome that destroys work nobody can recover.
    const locallyModified = recordedHash === undefined || recordedHash !== currentHash;

    if (locallyModified && !options.force) {
      result.skipped.push(relative);
      // Keep the recorded hash so the file stays recognised as user-owned. With
      // nothing recorded, record what is actually there, so the next run has a
      // baseline and a later `--force` still reports honestly.
      nextFiles[relative] = recordedHash ?? currentHash;
      continue;
    }

    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
    result.updated.push(relative);
    nextFiles[relative] = templateHash;
  }

  await writeManifest(manifestFile, options.templateSet, nextFiles);

  return result;
}
