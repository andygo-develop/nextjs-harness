/**
 * Console output for the CLI.
 *
 * The MCP server speaks JSON-RPC over stdout, so *nothing* else may be written
 * there while it runs. Calling `useStderr()` redirects all human-facing output
 * to stderr; `mcp start` does this before it touches anything else.
 */
type Level = 'info' | 'success' | 'warn' | 'error' | 'debug';

let verbose = false;
let stream: 'stdout' | 'stderr' = 'stdout';

const SYMBOLS: Record<Level, string> = {
  info: '·',
  success: '✔',
  warn: '!',
  error: '✖',
  debug: '›',
};

function write(level: Level, message: string): void {
  const target = level === 'error' || stream === 'stderr' ? process.stderr : process.stdout;
  const prefix = SYMBOLS[level];
  const body = message
    .split('\n')
    .map((line, i) => (i === 0 ? `${prefix} ${line}` : `  ${line}`))
    .join('\n');
  target.write(`${body}\n`);
}

export const logger = {
  setVerbose(value: boolean): void {
    verbose = value;
  },
  isVerbose(): boolean {
    return verbose;
  },
  /** Route all human-facing output to stderr (required for MCP stdio mode). */
  useStderr(): void {
    stream = 'stderr';
  },
  info(message: string): void {
    write('info', message);
  },
  success(message: string): void {
    write('success', message);
  },
  warn(message: string): void {
    write('warn', message);
  },
  error(message: string): void {
    write('error', message);
  },
  debug(message: string): void {
    if (verbose) {
      write('debug', message);
    }
  },
  /** Raw output with no symbol prefix — used for search results and reports. */
  print(message = ''): void {
    const target = stream === 'stderr' ? process.stderr : process.stdout;
    target.write(`${message}\n`);
  },
};
