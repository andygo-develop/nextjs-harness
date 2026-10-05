/**
 * Parses a project spec/doc file into indexable chunks.
 *
 * Reuses the manual's section splitter so project docs chunk exactly like
 * framework docs — per H2, code fences respected — but carries project-local
 * metadata (repo-relative path) instead of a nextjs.org URL.
 */
import { hashContent, resolveTitle, splitMarkdownSections } from '../manuals/parser.js';
import { parseFrontMatter, splitFrontMatter } from '../manuals/normalizer.js';

export interface SpecChunk {
  id: string;
  /** Project-relative POSIX path, e.g. "docs/billing.md". */
  path: string;
  title: string;
  heading?: string;
  anchor?: string;
  /** Top-level directory, e.g. "docs" — or "(root)" for a top-level file. */
  section: string;
  content: string;
  hash: string;
}

/** Grouping label for a spec file, taken from its top-level directory. */
export function sectionForSpecPath(relativePath: string): string {
  const segments = relativePath.split('/');
  return segments.length > 1 ? segments[0]! : '(root)';
}

export interface ParseSpecOptions {
  /** Project-relative POSIX path. */
  path: string;
  source: string;
}

export function parseSpec({ path: relativePath, source }: ParseSpecOptions): SpecChunk[] {
  const { frontMatter, body } = splitFrontMatter(source);
  const meta = parseFrontMatter(frontMatter);

  const title = resolveTitle(meta, body, relativePath);
  const section = sectionForSpecPath(relativePath);

  return splitMarkdownSections(body).map((chunk) => {
    const idBase = `spec:${relativePath}#${chunk.anchor ?? '_intro'}`;

    return {
      id: chunk.part ? `${idBase}~${chunk.part}` : idBase,
      path: relativePath,
      title,
      ...(chunk.heading ? { heading: chunk.heading } : {}),
      ...(chunk.anchor ? { anchor: chunk.anchor } : {}),
      section,
      content: chunk.content,
      hash: hashContent(chunk.content),
    };
  });
}
