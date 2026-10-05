/**
 * Text normalisation for indexing and excerpting.
 *
 * Documentation content is untrusted input. It is only ever treated as text:
 * never executed, never interpolated into a shell command, and never allowed
 * to influence control flow.
 */

/** Splits front matter from body. Returns the raw YAML block and the rest. */
export function splitFrontMatter(source: string): { frontMatter?: string; body: string } {
  const normalised = source.replace(/^﻿/, '');
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(normalised);
  if (!match) {
    return { body: normalised };
  }
  return { frontMatter: match[1], body: normalised.slice(match[0].length) };
}

/**
 * Reads scalar keys from a front-matter block.
 *
 * Deliberately minimal: the keys we need from Next.js's front matter (`title`,
 * `description`, `source`) are flat `key: value` pairs, and a full YAML
 * parser would be a dependency (and a parsing surface) we do not need. Nested
 * structures such as `related:` are ignored rather than guessed at.
 */
export function parseFrontMatter(frontMatter: string | undefined): Record<string, string> {
  if (!frontMatter) {
    return {};
  }

  const result: Record<string, string> = {};
  for (const line of frontMatter.split(/\r?\n/)) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!match) {
      continue;
    }
    const key = match[1]!;
    let value = (match[2] ?? '').trim();

    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    if (value) {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Reduces an MDX page body to the Markdown that is worth indexing.
 *
 * - `{/* … *\/}` comments are dropped (upstream uses them for editor notes);
 * - router-specific blocks are resolved: a Pages Router page keeps
 *   `<PagesOnly>` content and drops `<AppOnly>`, and vice versa — that is how
 *   one shared page renders differently under each router upstream;
 * - the JavaScript twin of a TypeScript "switcher" code sample is dropped,
 *   since it repeats the TypeScript one line for line.
 *
 * Fenced code is left untouched apart from that last rule.
 */
export function cleanMdx(body: string, router: 'app' | 'pages' | undefined): string {
  const dropped = router === 'pages' ? 'AppOnly' : router === 'app' ? 'PagesOnly' : undefined;
  const lines = body.split(/\r?\n/);
  const output: string[] = [];
  let fence: string | undefined;
  let skippingFence = false;
  let droppedDepth = 0;
  let inComment = false;

  for (const line of lines) {
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1]!;
      if (!fence) {
        fence = marker[0];
        skippingFence = /^\s*(js|jsx)\b.*\bswitcher\b/.test(fenceMatch[2] ?? '');
        if (!skippingFence && droppedDepth === 0) {
          output.push(line);
        }
        continue;
      }
      if (marker[0] === fence) {
        fence = undefined;
        if (!skippingFence && droppedDepth === 0) {
          output.push(line);
        }
        skippingFence = false;
        continue;
      }
    }
    if (fence) {
      if (!skippingFence && droppedDepth === 0) {
        output.push(line);
      }
      continue;
    }

    let text = line;
    if (inComment) {
      const end = text.indexOf('*/}');
      if (end === -1) {
        continue;
      }
      text = text.slice(end + 3);
      inComment = false;
    }
    text = text.replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
    const open = text.indexOf('{/*');
    if (open !== -1) {
      text = text.slice(0, open);
      inComment = true;
    }

    const tag = /^\s*<(\/?)(AppOnly|PagesOnly)>\s*$/.exec(text);
    if (tag) {
      if (tag[2] === dropped) {
        droppedDepth += tag[1] ? -1 : 1;
        droppedDepth = Math.max(droppedDepth, 0);
      }
      continue;
    }
    if (droppedDepth > 0) {
      continue;
    }

    if (text.trim() === '' && line.trim() !== '') {
      // The line held nothing but a comment.
      continue;
    }
    output.push(text);
  }

  return output.join('\n').replace(/\n{3,}/g, '\n\n');
}

/** Strips inline markdown decoration so headings read as plain text. */
export function stripInlineMarkdown(text: string): string {
  return text
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\\(.)/g, '$1')
    .trim();
}

/**
 * Slug used for the `#anchor` fragment of a heading.
 *
 * Matches the GitHub-style (github-slugger) ids nextjs.org renders for
 * headings: lowercase, drop everything but letters, marks, digits, `_`,
 * spaces and hyphens, then turn each space into a hyphen. Punctuation is
 * dropped rather than replaced, and hyphen runs are kept — `options.cache`
 * is `#optionscache`, "CSS / Sass / SCSS" is `#css--sass--scss` — so a chunk's
 * URL lands on its section rather than the top of the page.
 */
export function slugify(heading: string): string {
  return stripInlineMarkdown(heading)
    .toLowerCase()
    .replace(/[^\p{Alphabetic}\p{M}\p{Nd}\p{Pc} -]/gu, '')
    .replace(/ /g, '-');
}

/**
 * Flattens markdown into text suited to BM25 matching and excerpting.
 *
 * Code fences keep their contents — a query for `SelectQuery` or `find()`
 * should match the example that uses it — but the fence markers, container
 * directives and table pipes are dropped so they do not pollute tokens.
 */
export function toSearchText(markdown: string): string {
  return markdown
    .replace(/^```[^\n]*$/gm, '')
    .replace(/^:::+\s*\w*/gm, '')
    .replace(/^\s*\|/gm, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Collapses text to a single-line excerpt of at most `maxLength` characters.
 *
 * Unlike `toSearchText`, this also unwraps bold/italic markers and markdown
 * backslash escapes so an excerpt reads as `app.module.ts` rather than
 * `app\.module\.**ts**`. That transformation is display-only — it is never
 * applied to indexed content, where unescaping could corrupt code samples.
 */
export function toExcerpt(text: string, maxLength = 320): string {
  const flat = toSearchText(text)
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(?<![*\w])\*([^*\n]+)\*(?!\w)/g, '$1')
    .replace(/\\([\\`*_{}[\]()#+\-.!])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  if (flat.length <= maxLength) {
    return flat;
  }
  const clipped = flat.slice(0, maxLength);
  const lastSpace = clipped.lastIndexOf(' ');
  return `${(lastSpace > maxLength * 0.6 ? clipped.slice(0, lastSpace) : clipped).trimEnd()}…`;
}
