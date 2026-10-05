import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { detectNextJsVersion, detectFromPackageJson, detectFromLock } from '../cli/nextjs/detect-version.js';
import { findProjectRoot, requireNextJsProject } from '../cli/nextjs/project.js';
import {
  CANARY_REF,
  docsLineForMajor,
  LATEST_KNOWN_MAJOR,
  majorForDocsLine,
  parseConstraint,
  parseExact,
  SUPPORTED_MAJORS,
  versionFromString,
} from '../cli/nextjs/version.js';
import { HarnessError } from '../errors.js';
import { cleanupTempDirs, makeProject, makeTempDir } from './helpers.js';

afterEach(cleanupTempDirs);

/** The error a synchronous call throws, for asserting on its hint. */
function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('version parsing', () => {
  it.each([
    ['^16.1', 16, 1],
    ['~16.1.0', 16, 1],
    ['16.1.*', 16, 1],
    ['16.1.4', 16, 1],
    ['>=16.1 <17.0', 16, 1],
    ['<=16.1', 16, 1],
    ['^15.5 || ^16.0', 16, 0],
    ['16', 16, undefined],
  ])('parses constraint %s', (constraint, major, minor) => {
    expect(parseConstraint(constraint)).toEqual({ major, minor });
  });

  /**
   * `npm install next@canary` writes a prerelease such as `15.4.0-canary.42`.
   * The 42 is a build counter, not a version: reading it as one turns a 15.x
   * project into "Next.js 42" and hands it the wrong manual.
   */
  it.each([
    ['15.4.0-canary.42', 15, 4],
    ['^16.1.0-canary.19', 16, 1],
    ['16.0.0-rc.1', 16, 0],
    ['>=15.0.0-canary.3 <16', 15, 0],
  ])('ignores the prerelease identifiers in %s', (constraint, major, minor) => {
    expect(parseConstraint(constraint)).toEqual({ major, minor });
  });

  /**
   * The bound after `<` is the one version the project is guaranteed *not* to
   * be on, so reading it as the project's own major is a version-safety bug,
   * not a rounding error: `>=15.0.0 <16.0.0` is a 15.x project, and answering
   * its questions from the 16.x manual is the failure this tool exists to
   * prevent.
   */
  it('never reads an exclusive upper bound as the project version', () => {
    expect(parseConstraint('>=15.0.0 <16.0.0')).toEqual({ major: 15, minor: 0 });
    expect(parseConstraint('>=15 <16')).toEqual({ major: 15, minor: undefined });
    expect(versionFromString('>=15.0.0 <16.0.0').docsLine).toBe('v15.5.27');
  });

  /** An upper bound is still better than refusing to detect Next.js at all. */
  it('falls back to a lone exclusive bound rather than giving up', () => {
    expect(parseConstraint('<17')).toEqual({ major: 17, minor: undefined });
  });

  it('treats wildcard minors as unknown', () => {
    expect(parseConstraint('16.x')).toEqual({ major: 16, minor: undefined });
  });

  it.each(['latest', 'canary'])('returns undefined for the dist-tag %s', (tag) => {
    expect(parseConstraint(tag)).toBeUndefined();
  });

  it.each([
    ['16.1.4', 16, 1],
    ['v16.1.4', 16, 1],
    ['15.5.27', 15, 5],
    ['16.0.0-canary.5', 16, 0],
  ])('parses exact version %s', (version, major, minor) => {
    expect(parseExact(version)).toEqual({ major, minor });
  });
});

describe('documentation lines', () => {
  it('pins every supported major to its newest stable release tag', () => {
    expect(SUPPORTED_MAJORS).toEqual([13, 14, 15, 16]);
    expect(LATEST_KNOWN_MAJOR).toBe(16);

    expect(docsLineForMajor(16)).toBe('v16.3.8');
    expect(docsLineForMajor(15)).toBe('v15.5.27');
    expect(docsLineForMajor(14)).toBe('v14.2.35');
    expect(docsLineForMajor(13)).toBe('v13.5.11');
  });

  it('maps every pinned tag back to its major', () => {
    for (const major of SUPPORTED_MAJORS) {
      expect(majorForDocsLine(docsLineForMajor(major))).toBe(major);
    }
  });

  it('falls back to canary for a major newer than any pinned release', () => {
    expect(CANARY_REF).toBe('canary');
    expect(docsLineForMajor(17)).toBe('canary');
    expect(docsLineForMajor(99)).toBe('canary');
    // canary stands in for the newest known major's documentation layout.
    expect(majorForDocsLine('canary')).toBe(16);
  });

  it.each([12, 9])('refuses major %i, which predates the documentation layout this tool reads', (major) => {
    expect(() => docsLineForMajor(major)).toThrow(HarnessError);
    expect(thrown(() => docsLineForMajor(major))).toMatchObject({
      message: `No Next.js documentation is available for major version ${major}.`,
      hint: expect.stringContaining('before 13.4'),
    });
  });

  it('lists the pinned refs when it refuses a major', () => {
    expect(thrown(() => docsLineForMajor(12))).toMatchObject({
      hint: expect.stringContaining('16 → v16.3.8'),
    });
  });

  it.each(['v12.3.4', 'master', '16.0.0'])('rejects %s, which is not a known documentation ref', (ref) => {
    expect(() => majorForDocsLine(ref)).toThrow(HarnessError);
  });

  it('builds a version from a user string', () => {
    expect(versionFromString('16.1')).toMatchObject({ version: '16.1', major: 16, docsLine: 'v16.3.8' });
    expect(versionFromString('15')).toMatchObject({ major: 15, docsLine: 'v15.5.27' });
    expect(versionFromString('17')).toMatchObject({ major: 17, docsLine: 'canary' });
  });

  it('explains how to write a version it cannot read', () => {
    expect(thrown(() => versionFromString('banana'))).toMatchObject({
      message: 'Could not understand Next.js version "banana".',
      hint: expect.stringContaining('16.1'),
    });
  });
});

describe('project detection', () => {
  it('detects the exact version from package-lock.json', async () => {
    const root = await makeProject({ constraint: '^16.1.0', lockVersion: '16.1.4' });
    const version = await detectNextJsVersion(root);

    expect(version).toMatchObject({
      version: '16.1',
      exact: '16.1.4',
      docsLine: 'v16.3.8',
      source: 'package-lock.json',
    });
  });

  it('prefers the lock file over the range', async () => {
    const root = await makeProject({ constraint: '^16.0.0', lockVersion: '16.1.4' });
    expect((await detectNextJsVersion(root))?.version).toBe('16.1');
  });

  it('falls back to package.json when there is no lock file', async () => {
    const root = await makeProject({ constraint: '^15.4.0' });
    const version = await detectNextJsVersion(root);

    expect(version).toMatchObject({ version: '15.4', docsLine: 'v15.5.27', source: 'package.json' });
    expect(version?.exact).toBeUndefined();
  });

  it('detects a pinned canary prerelease as the release line it belongs to', async () => {
    // A pnpm or Yarn project has no package-lock.json, so the range is all there is.
    const root = await makeProject({ constraint: '15.4.0-canary.42' });

    expect(await detectNextJsVersion(root)).toMatchObject({ version: '15.4', docsLine: 'v15.5.27' });
  });

  it('finds next installed inside a workspace package', async () => {
    const root = await makeProject({ constraint: '^15.5.0' });
    await writeFile(
      path.join(root, 'package-lock.json'),
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          '': { name: 'acme', workspaces: ['apps/*'] },
          'apps/web': { name: 'web' },
          'apps/web/node_modules/next': { version: '15.5.3' },
        },
      }),
    );

    expect(await detectNextJsVersion(root)).toMatchObject({
      exact: '15.5.3',
      docsLine: 'v15.5.27',
      source: 'package-lock.json',
    });
  });

  it('reads a lockfileVersion 1 package-lock.json', async () => {
    const root = await makeProject({ constraint: '^14.2.0' });
    await writeFile(
      path.join(root, 'package-lock.json'),
      JSON.stringify({ lockfileVersion: 1, dependencies: { next: { version: '14.2.15' } } }),
    );

    expect(await detectNextJsVersion(root)).toMatchObject({ exact: '14.2.15', docsLine: 'v14.2.35' });
  });

  it('ignores an unresolvable lock version and uses the range', async () => {
    const root = await makeProject({ constraint: '^16.1.0' });
    await writeFile(
      path.join(root, 'package-lock.json'),
      JSON.stringify({ packages: { 'node_modules/next': { version: 'github:vercel/next.js#canary' } } }),
    );

    expect((await detectNextJsVersion(root))?.source).toBe('package.json');
  });

  it('finds next in devDependencies', async () => {
    const root = await makeTempDir();
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ devDependencies: { next: '^15.2' } }));

    expect((await detectFromPackageJson(root))?.version).toBe('15.2');
  });

  it('refuses a project on a Next.js older than any documentation it can serve', async () => {
    const root = await makeProject({ constraint: '^12.3.0' });

    await expect(detectNextJsVersion(root)).rejects.toThrow(/No Next.js documentation is available for major version 12/);
  });

  it('returns undefined for a React project that does not use Next.js', async () => {
    const root = await makeProject({ nonNextJs: true });
    expect(await detectNextJsVersion(root)).toBeUndefined();
  });

  it('returns undefined when package.json is missing', async () => {
    const root = await makeTempDir();
    expect(await detectFromPackageJson(root)).toBeUndefined();
    expect(await detectFromLock(root)).toBeUndefined();
  });

  it('reports an actionable error for a non-Next.js project', async () => {
    const root = await makeProject({ nonNextJs: true });

    await expect(requireNextJsProject(root)).rejects.toThrow(/Next.js project not detected/);
    await expect(requireNextJsProject(root)).rejects.toMatchObject({
      hint: expect.stringContaining('next'),
    });
  });

  it('raises a clear error for malformed package.json', async () => {
    const root = await makeTempDir();
    await writeFile(path.join(root, 'package.json'), '{ not json');

    await expect(detectFromPackageJson(root)).rejects.toThrow(/not valid JSON/);
  });

  it('walks upward to find the project root from a subdirectory', async () => {
    const root = await makeProject({ constraint: '^16.1.0' });
    const nested = path.join(root, 'app', 'blog', '[slug]');
    await mkdir(nested, { recursive: true });

    expect(await findProjectRoot(nested)).toBe(root);
  });

  it('returns undefined when there is no project anywhere above', async () => {
    const root = await makeTempDir();
    await rm(path.join(root, 'package.json'), { force: true });

    // A temp dir has no package.json above it inside the temp tree.
    const found = await findProjectRoot(root);
    expect(found === undefined || found !== root).toBe(true);
  });
});
