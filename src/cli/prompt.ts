/**
 * Minimal yes/no prompt.
 *
 * Defaults to "no" whenever the session is not interactive, so CI runs never
 * hang waiting for input and never write files nobody approved. `--yes` is the
 * way to opt in non-interactively.
 */
import { createInterface } from 'node:readline/promises';

export async function confirm(question: string, options: { assumeYes?: boolean } = {}): Promise<boolean> {
  if (options.assumeYes) {
    return true;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return false;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}
