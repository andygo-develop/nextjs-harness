/**
 * Errors that are expected parts of normal CLI operation.
 *
 * A HarnessError carries an actionable hint alongside its message. The CLI
 * boundary prints both and exits non-zero *without* a stack trace, because a
 * stack trace for "you haven't synced the manuals yet" is noise. Anything that
 * is not a HarnessError is a genuine bug and does get its stack printed.
 */
export class HarnessError extends Error {
  readonly hint?: string;
  readonly exitCode: number;

  constructor(message: string, options: { hint?: string; exitCode?: number; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = 'HarnessError';
    this.hint = options.hint;
    this.exitCode = options.exitCode ?? 1;
  }
}

/** Formats commands as an indented block for use in a hint. */
export function commandHint(...commands: string[]): string {
  return `Run:\n\n${commands.map((c) => `  ${c}`).join('\n')}`;
}

export function isHarnessError(error: unknown): error is HarnessError {
  return error instanceof HarnessError;
}

/** Thrown when the current directory is not a Next.js project. */
export function notANextJsProject(searchedFrom: string): HarnessError {
  return new HarnessError('Next.js project not detected.', {
    hint:
      `Expected a package.json depending on next, searched upward from:\n\n  ${searchedFrom}\n\n` +
      'Run this command from the root of a Next.js project.',
  });
}

/** Thrown when the harness has not been initialised in this project. */
export function notInitialised(): HarnessError {
  return new HarnessError('This project has not been initialised for nextjs-harness.', {
    hint: commandHint('nextjs-harness setup'),
  });
}
