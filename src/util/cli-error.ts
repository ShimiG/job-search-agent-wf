import { ConfigError } from '../config.ts';

/**
 * What to print when a command fails. A setting that's wrong or an option the command doesn't know is
 * your input, so it gets one plain line; anything else is a bug, and keeps its stack trace.
 */
export function cliErrorMessage(err: unknown, helpCommand: string): string | null {
  if (err instanceof ConfigError) return err.message;
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code !== 'string' || !code.startsWith('ERR_PARSE_ARGS_')) return null;
  const option = /option '([^']+)'/.exec((err as Error).message)?.[1];
  const what =
    code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' && option
      ? `This version doesn't have the option ${option}.`
      : (err as Error).message.split('. To specify')[0]!.replace(/\.?$/, '.');
  // An option from the README that isn't here usually means the code is older than the README you read.
  return `${what} Run "${helpCommand}" for what it takes. If the option is in the README, update first: git pull`;
}
