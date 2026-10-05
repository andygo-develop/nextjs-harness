/**
 * Parses a Next.js documentation page into indexable chunks.
 *
 * Chunking is per H2 section rather than per page. A page like the `fetch`
 * API reference is hundreds of lines long; indexing it whole would rank badly under BM25 and
 * force the MCP server to hand an agent an enormous blob. A section is the unit
 * a developer actually wants back.
 *
 * The output is deterministic: the same file always yields the same chunk ids,
 * anchors and hashes, which is what makes incremental re-indexing possible.
 */
import { createHash } from 'node:crypto';

import { CANARY_REF, LATEST_KNOWN_MAJOR, majorForDocsLine } from '../../cli/nextjs/version.js';
import { cleanMdx, parseFrontMatter, slugify, splitFrontMatter, stripInlineMarkdown } from './normalizer.js';

/** Chunks larger than this are split further, at H3 then at paragraphs. */
const MAX_CHUNK_CHARS = 12_000;

export interface ParsedChunk {
  id: string;
  docsLine: string;
  lang: string;
  /** Path relative to the docs directory, e.g. "01-app/03-api-reference/04-functions/fetch.mdx". */
  path: string;
  title: string;
  heading?: string;
  anchor?: string;
  section: string;
  url: string;
  content: string;
  hash: string;
}

interface Heading {
  index: number;
  level: number;
  text: string;
}

/** Human labels for documentation directories, keyed by prefix-stripped name. */
const SECTION_LABELS: Record<string, string> = {
  app: 'App Router',
  pages: 'Pages Router',
  architecture: 'Architecture',
  community: 'Community',
  'getting-started': 'Getting Started',
  'building-your-application': 'Building Your Application',
  'api-reference': 'API Reference',
  guides: 'Guides',
  glossary: 'Glossary',
  index: 'Introduction',
};

function titleCase(slug: string): string {
  return slug
    .split(/[-_]/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * The public route of a documentation file, relative to `/docs`.
 *
 * Upstream orders pages with numeric prefixes (`01-app/02-guides/…`) that
 * never appear in a URL, and an `index.mdx` is the page for its directory:
 * `01-app/01-getting-started/06-fetching-data.mdx` → `app/getting-started/fetching-data`.
 * This is also the form a page's `source:` front matter uses to point at the
 * page whose content it shares.
 */
export function docsRoute(relativePath: string): string {
  const segments = relativePath
    .replace(/\.mdx?$/, '')
    .split('/')
    .map((segment) => segment.replace(/^\d+-/, ''));
  if (segments[segments.length - 1] === 'index') {
    segments.pop();
  }
  return segments.join('/');
}

/** Which router a documentation file describes, from its first route segment. */
export function routerForPath(relativePath: string): 'app' | 'pages' | undefined {
  const first = docsRoute(relativePath).split('/')[0];
  return first === 'app' || first === 'pages' ? first : undefined;
}

/**
 * Section label for a page: its top-level area, plus the sub-area when the
 * page sits below one — "App Router › API Reference".
 */
export function sectionForPath(relativePath: string): string {
  const segments = docsRoute(relativePath).split('/').filter(Boolean);
  const label = (key: string): string => SECTION_LABELS[key] ?? titleCase(key);

  if (segments.length === 0) {
    return label('index');
  }
  if (segments.length <= 2) {
    return label(segments[0]!);
  }
  return `${label(segments[0]!)} › ${label(segments[1]!)}`;
}

/**
 * Public nextjs.org URL for a documentation path.
 *
 * nextjs.org serves the newest major at `/docs/…` and keeps earlier majors
 * under a version segment (`/docs/15/…`, `/docs/14/…`), so the URL a page
 * links to follows the major its `docsLine` covers. `lang` is accepted for a
 * uniform signature with the rest of the corpus; the docs are English-only.
 */
export function urlForPath(docsLine: string, _lang: string, relativePath: string, anchor?: string): string {
  const major = docsLine === CANARY_REF ? LATEST_KNOWN_MAJOR : majorForDocsLine(docsLine);
  const versionSegment = major >= LATEST_KNOWN_MAJOR ? '' : `/${major}`;
  const route = docsRoute(relativePath);
  const base = `https://nextjs.org/docs${versionSegment}${route ? `/${route}` : ''}`;
  return anchor ? `${base}#${anchor}` : base;
}

export function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 40);
}

/**
 * Finds ATX headings, ignoring anything inside a fenced code block — shell
 * and YAML samples are full of lines beginning with `#`, and treating those
 * as headings would shred the document.
 */
function findHeadings(lines: string[]): Heading[] {
  const headings: Heading[] = [];
  let fence: string | undefined;

  for (const [index, line] of lines.entries()) {
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1]!;
      if (!fence) {
        fence = marker[0];
      } else if (marker[0] === fence) {
        fence = undefined;
      }
      continue;
    }
    if (fence) {
      continue;
    }

    const headingMatch = /^(#{1,6})\s+(.*)$/.exec(line);
    if (headingMatch) {
      headings.push({
        index,
        level: headingMatch[1]!.length,
        text: stripInlineMarkdown(headingMatch[2]!),
      });
    }
  }

  return headings;
}

interface Segment {
  heading?: Heading;
  lines: string[];
}

/** Splits lines into a preamble plus one segment per heading of `level`. */
function splitAtLevel(lines: string[], headings: Heading[], level: number, offset: number): Segment[] {
  const boundaries = headings.filter((h) => h.level === level);
  if (boundaries.length === 0) {
    return [{ lines }];
  }

  const segments: Segment[] = [];
  const first = boundaries[0]!.index - offset;
  if (first > 0) {
    const preamble = lines.slice(0, first);
    if (preamble.join('\n').trim()) {
      segments.push({ lines: preamble });
    }
  }

  for (const [i, heading] of boundaries.entries()) {
    const start = heading.index - offset;
    const next = boundaries[i + 1];
    const end = next ? next.index - offset : lines.length;
    segments.push({ heading, lines: lines.slice(start, end) });
  }

  return segments;
}

/** Last-resort split for a section with no sub-headings and lots of prose. */
function splitByParagraph(text: string): string[] {
  const paragraphs = text.split(/\n{2,}/);
  const parts: string[] = [];
  let buffer = '';

  for (const paragraph of paragraphs) {
    if (buffer && buffer.length + paragraph.length + 2 > MAX_CHUNK_CHARS) {
      parts.push(buffer);
      buffer = paragraph;
    } else {
      buffer = buffer ? `${buffer}\n\n${paragraph}` : paragraph;
    }
  }
  if (buffer.trim()) {
    parts.push(buffer);
  }

  return parts.length > 0 ? parts : [text];
}

/** One indexable slice of a Markdown document. */
export interface MarkdownSection {
  heading?: string;
  /** Slug of the heading, deduplicated within the document. */
  anchor?: string;
  content: string;
  /** Set (2, 3, …) when an oversized section had to be split further. */
  part?: number;
}

/**
 * Splits a Markdown body into indexable sections.
 *
 * Shared by the framework manual and the project spec indexers so both chunk
 * identically — per H2, falling back to H3 then paragraphs when a section is
 * too large, ignoring `#` lines inside code fences, and dropping sections that
 * contain nothing but their own heading.
 */
export function splitMarkdownSections(body: string): MarkdownSection[] {
  const lines = body.split(/\r?\n/);
  const headings = findHeadings(lines);
  const segments = splitAtLevel(lines, headings, 2, 0);

  const sections: MarkdownSection[] = [];
  /** How many headings have wanted each base slug, for the `-1`, `-2` suffixes. */
  const usedAnchors = new Map<string, number>();
  /** Every anchor actually handed out, so no two chunks can end up sharing one. */
  const takenAnchors = new Set<string>();

  const push = (heading: Heading | undefined, text: string, part?: number): void => {
    const content = text.trim();
    if (!content) {
      return;
    }

    // A chunk consisting of nothing but its own heading carries no information
    // — it would match a search and then return an empty document.
    const contentLines = content.split('\n');
    const bodyStart = /^#{1,6}\s+/.test(contentLines[0] ?? '') ? 1 : 0;
    if (!contentLines.slice(bodyStart).join('\n').trim()) {
      return;
    }

    let anchor: string | undefined;
    if (heading) {
      const base = slugify(heading.text) || 'section';
      // The suffixed form of one heading can collide with the plain form of
      // another — "Usage" twice plus a "Usage 1" all want `usage-1`. Chunk ids
      // are built from the anchor and `documents.id` is a primary key, so a
      // collision is not a cosmetic duplicate: the insert fails and takes the
      // whole index run down with it. Counting past anchors already handed out
      // costs nothing in the overwhelmingly common case (no collision) and
      // keeps ids unique in the rest.
      let seen = usedAnchors.get(base) ?? 0;
      let candidate = seen === 0 ? base : `${base}-${seen}`;
      while (takenAnchors.has(candidate)) {
        seen += 1;
        candidate = `${base}-${seen}`;
      }

      usedAnchors.set(base, seen + 1);
      takenAnchors.add(candidate);
      anchor = candidate;
    }

    sections.push({
      ...(heading ? { heading: heading.text } : {}),
      ...(anchor ? { anchor } : {}),
      content,
      ...(part && part > 1 ? { part } : {}),
    });
  };

  for (const segment of segments) {
    const text = segment.lines.join('\n');

    if (text.length <= MAX_CHUNK_CHARS) {
      push(segment.heading, text);
      continue;
    }

    // Too large: try H3 boundaries within this section.
    const offset = segment.heading ? segment.heading.index : 0;
    const inner = findHeadings(segment.lines).map((h) => ({ ...h, index: h.index + offset }));
    const subSegments = splitAtLevel(segment.lines, inner, 3, offset);

    if (subSegments.length > 1) {
      for (const sub of subSegments) {
        const subText = sub.lines.join('\n');
        if (subText.length <= MAX_CHUNK_CHARS) {
          push(sub.heading ?? segment.heading, subText);
        } else {
          for (const [i, part] of splitByParagraph(subText).entries()) {
            push(sub.heading ?? segment.heading, part, i + 1);
          }
        }
      }
      continue;
    }

    for (const [i, part] of splitByParagraph(text).entries()) {
      push(segment.heading, part, i + 1);
    }
  }

  return sections;
}

/** Document title: front matter, else the H1, else the filename. */
export function resolveTitle(
  meta: Record<string, string>,
  body: string,
  relativePath: string,
): string {
  const h1 = findHeadings(body.split(/\r?\n/)).find((heading) => heading.level === 1);
  return meta.title ?? h1?.text ?? titleCase(docsRoute(relativePath).split('/').pop() || 'Introduction');
}

export interface ParsePageOptions {
  docsLine: string;
  lang: string;
  /** Path relative to the docs directory, e.g. "01-app/03-api-reference/04-functions/fetch.mdx". */
  path: string;
  source: string;
  /**
   * Raw text of the page named by this page's `source:` front matter, when
   * it has one. Pages Router pages often carry no content of their own and
   * share an App Router page's, filtered through `<PagesOnly>`/`<AppOnly>`.
   */
  sharedSource?: string;
}

export function parsePage({
  docsLine,
  lang,
  path: relativePath,
  source,
  sharedSource,
}: ParsePageOptions): ParsedChunk[] {
  const own = splitFrontMatter(source);
  const meta = parseFrontMatter(own.frontMatter);
  const rawBody = meta.source && sharedSource !== undefined ? splitFrontMatter(sharedSource).body : own.body;
  const body = cleanMdx(rawBody, routerForPath(relativePath));

  const title = resolveTitle(meta, body, relativePath);
  const section = sectionForPath(relativePath);

  return splitMarkdownSections(body).map((sectionChunk) => {
    const idBase = `${docsLine}:${lang}:${relativePath}#${sectionChunk.anchor ?? '_intro'}`;
    const id = sectionChunk.part ? `${idBase}~${sectionChunk.part}` : idBase;

    return {
      id,
      docsLine,
      lang,
      path: relativePath,
      title,
      ...(sectionChunk.heading ? { heading: sectionChunk.heading } : {}),
      ...(sectionChunk.anchor ? { anchor: sectionChunk.anchor } : {}),
      section,
      url: urlForPath(docsLine, lang, relativePath, sectionChunk.anchor),
      content: sectionChunk.content,
      hash: hashContent(sectionChunk.content),
    };
  });
}
