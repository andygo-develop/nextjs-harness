/**
 * Reading the YAML front matter our own templates carry.
 *
 * Deliberately not a YAML parser: the only front matter this ever sees is the
 * templates in `src/templates/`, which use flat `key: value` lines. A real
 * parser would be a dependency and a licence to accept shapes the writers below
 * could not render anyway.
 */
export interface FrontMatter {
  attributes: Record<string, string>;
  body: string;
}

const BLOCK = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function splitFrontMatter(source: string): FrontMatter {
  const match = BLOCK.exec(source);
  if (!match) {
    return { attributes: {}, body: source };
  }

  const attributes: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator <= 0) {
      continue;
    }
    attributes[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }

  return { attributes, body: source.slice(match[0].length).replace(/^\s*\n/, '') };
}

/** The `tools:` line as a list, or undefined when the template omits it. */
export function toolList(attributes: Record<string, string>): string[] | undefined {
  const tools = attributes.tools;
  if (!tools) {
    return undefined;
  }
  return tools
    .split(',')
    .map((tool) => tool.trim())
    .filter(Boolean);
}