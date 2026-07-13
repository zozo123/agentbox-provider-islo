import { randomUUID } from 'node:crypto';

const RC_SENTINEL_PREFIX = '__AGENTBOX_ISLO_RC_';

export interface WrappedExec {
  command: string;
  sentinel: string;
}

/**
 * Islo keeps an exec running while a detached descendant remains alive. Run the
 * requested command in a subshell, then emit a per-exec marker from the parent
 * shell so foreground completion is observable through streamed stdout.
 */
export function wrapWithRcSentinel(command: string): WrappedExec {
  const sentinel = `${RC_SENTINEL_PREFIX}${randomUUID().replaceAll('-', '')}__`;
  return {
    sentinel,
    command: `(\n${command}\n)\n__agentbox_islo_rc=$?\nprintf '\\n%s %s\\n' ${sentinel} "$__agentbox_islo_rc"`,
  };
}

export function parseRcSentinel(
  stdout: string,
  sentinel: string,
): { exitCode: number; stdout: string } | null {
  const match = new RegExp(`(?:^|\\n)${sentinel} (\\d+)\\n?$`).exec(stdout);
  if (!match) return null;
  return { exitCode: Number(match[1]), stdout: stdout.slice(0, match.index) };
}
