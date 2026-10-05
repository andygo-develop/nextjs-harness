/**
 * The Next.js version model.
 *
 * Next.js documentation lives inside the framework's own monorepo
 * (vercel/next.js, under `docs/`), so the documentation for a release is
 * whatever `docs/` looked like at that release's git tag. We pin every known
 * major to the tag of its newest stable release deliberately: a tag never
 * moves, so the corpus a project syncs today is byte-for-byte the corpus it
 * syncs next month, not something that can silently drift out from under an
 * index between two runs of `manuals update`.
 *
 * `canary` is not "the current major's documentation" — it is the *stopgap*
 * for a major newer than anything in `DOCS_REF_BY_MAJOR` below, used only
 * because no stable tag for it is known yet. When Next.js ships a new major
 * (or a newer minor of a known one that the docs should follow), that map
 * gains or updates an explicit, pinned entry.
 *
 * We still track two related but distinct things:
 *
 *   - `version`     the project's Next.js version ("16.1"), for display/config
 *   - `docsLine`    the git ref its documentation is read from ("v16.3.8", …)
 *
 * Version safety is defined at the major-line boundary: a 16.x project must
 * never be served 15.x documentation, and vice versa.
 */
import { HarnessError } from '../../errors.js';

export interface NextJsVersion {
  /** Exact version when resolved from package-lock.json, e.g. "16.1.4". */
  exact?: string;
  /** Display version, "major.minor" when known, otherwise "major". */
  version: string;
  major: number;
  minor?: number;
  /** Documentation git ref/corpus identifier, e.g. "v16.3.8" or "v15.5.27". */
  docsLine: string;
  /** Where the version came from. */
  source: 'package-lock.json' | 'package.json' | 'config' | 'explicit';
}

/**
 * Pinned documentation refs in vercel/next.js — the newest stable release tag
 * of each major line, verified against the repository's tags. Every one of
 * them has the numbered `docs/**\/*.mdx` layout the parser expects (13.4 is
 * where that layout appeared, so 13 is pinned to a 13.5 release).
 */
const DOCS_REF_BY_MAJOR: Record<number, string> = {
  13: 'v13.5.11',
  14: 'v14.2.35',
  15: 'v15.5.27',
  16: 'v16.3.8',
};

/** The moving branch used for a major newer than anything pinned above. */
export const CANARY_REF = 'canary';

/**
 * The newest major line this map knows about. A project on a *newer* major
 * than this (one that shipped after this file was last updated) is pointed
 * at `canary` as a stopgap, since that is the only documentation upstream has
 * for it that we can name without a release list — the alternative is
 * refusing a project on legitimate, current Next.js outright. This map should
 * gain an explicit, pinned entry for that major once it has a stable tag.
 */
export const LATEST_KNOWN_MAJOR = Math.max(...Object.keys(DOCS_REF_BY_MAJOR).map(Number));

export const SUPPORTED_MAJORS = Object.keys(DOCS_REF_BY_MAJOR).map(Number);

export function docsLineForMajor(major: number): string {
  const line = DOCS_REF_BY_MAJOR[major];
  if (line) {
    return line;
  }
  if (major > LATEST_KNOWN_MAJOR) {
    return CANARY_REF;
  }
  throw new HarnessError(`No Next.js documentation is available for major version ${major}.`, {
    hint:
      `Known documentation refs: ${Object.entries(DOCS_REF_BY_MAJOR)
        .map(([m, line]) => `${m} → ${line}`)
        .join(', ')}.\n` +
      'Next.js releases before 13.4 do not ship documentation in the layout this tool reads.',
  });
}

/** The major version number a docs line covers, e.g. "v15.5.27" -> 15. */
export function majorForDocsLine(docsLine: string): number {
  if (docsLine === CANARY_REF) {
    return LATEST_KNOWN_MAJOR;
  }
  const entry = Object.entries(DOCS_REF_BY_MAJOR).find(([, line]) => line === docsLine);
  if (!entry) {
    throw new HarnessError(`Unknown Next.js documentation ref: ${docsLine}`, {
      hint: `Known documentation refs: ${Object.values(DOCS_REF_BY_MAJOR).join(', ')}, ${CANARY_REF}.`,
    });
  }
  return Number(entry[0]);
}

/**
 * Extracts the highest major.minor pair from an npm version range.
 *
 * npm ranges are varied: "^16.0.0", "~16.1.0", "16.1.4", ">=15.0.0 <17.0.0",
 * "^15.0.0 || ^16.0.0". We take the highest major mentioned — for an
 * either/or range the newest line is the one a project is realistically on
 * — and the highest minor within it.
 *
 * With one exception, and it is a version-safety one: a version behind an
 * *exclusive* `<` is the one version the project provably is **not** on.
 * Reading `>=15.0.0 <16.0.0` as "major 16" would hand a 15.x project the 16.x
 * manual, which is exactly the mix-up this whole tool exists to prevent, so
 * exclusive upper bounds are dropped before picking the highest. `<=` is a
 * real, reachable bound and still counts.
 *
 * A range consisting of nothing but exclusive bounds ("<17") leaves no
 * candidate at all; rather than declare the project's Next.js undetectable, we
 * fall back to the highest mentioned, since a rejected project helps nobody.
 */
export function parseConstraint(constraint: string): { major: number; minor?: number } | undefined {
  // A prerelease or build suffix is not a version: `next@canary` installs
  // ranges like "^15.4.0-canary.42", and reading that 42 as a major would hand
  // a 15.x project the wrong manual.
  const release = constraint.replace(/(\d)[-+][0-9A-Za-z][0-9A-Za-z.-]*/g, '$1');
  const matches = [...release.matchAll(/(<=?)?\s*v?(\d+)(?:\.(\d+|[x*]))?/gi)];
  if (matches.length === 0) {
    return undefined;
  }

  let best: { major: number; minor?: number } | undefined;
  let fallback: { major: number; minor?: number } | undefined;

  for (const match of matches) {
    const exclusiveUpperBound = match[1] === '<';
    const major = Number(match[2]);
    const rawMinor = match[3];
    const minor = rawMinor && /^\d+$/.test(rawMinor) ? Number(rawMinor) : undefined;

    const higherThan = (current: { major: number; minor?: number } | undefined): boolean =>
      !current ||
      major > current.major ||
      (major === current.major && (minor ?? -1) > (current.minor ?? -1));

    if (higherThan(fallback)) {
      fallback = { major, minor };
    }
    if (!exclusiveUpperBound && higherThan(best)) {
      best = { major, minor };
    }
  }

  return best ?? fallback;
}

/** Parses an exact version such as "16.1.4" or "v16.1.4". */
export function parseExact(version: string): { major: number; minor?: number } | undefined {
  const match = /^v?(\d+)\.(\d+)/.exec(version.trim());
  if (!match) {
    return undefined;
  }
  return { major: Number(match[1]), minor: Number(match[2]) };
}

export function formatVersion(major: number, minor?: number): string {
  return minor === undefined ? String(major) : `${major}.${minor}`;
}

/** Builds a full NextJsVersion from a major/minor pair. */
export function buildVersion(
  parts: { major: number; minor?: number },
  source: NextJsVersion['source'],
  exact?: string,
): NextJsVersion {
  return {
    exact,
    version: formatVersion(parts.major, parts.minor),
    major: parts.major,
    minor: parts.minor,
    docsLine: docsLineForMajor(parts.major),
    source,
  };
}

/**
 * Builds a version from a user-supplied string such as "16.1" or "16".
 * Used by `--version` flags.
 */
export function versionFromString(input: string, source: NextJsVersion['source'] = 'explicit'): NextJsVersion {
  const parts = parseConstraint(input);
  if (!parts) {
    throw new HarnessError(`Could not understand Next.js version "${input}".`, {
      hint: 'Use a version like 16, 16.1 or 15.',
    });
  }
  return buildVersion(parts, source);
}
