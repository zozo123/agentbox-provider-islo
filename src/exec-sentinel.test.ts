import { describe, expect, it } from 'vitest';
import { parseRcSentinel, wrapWithRcSentinel } from './exec-sentinel.js';

describe('exec completion sentinel', () => {
  it('uses a unique marker and preserves stdout', () => {
    const first = wrapWithRcSentinel('printf hello');
    const second = wrapWithRcSentinel('printf hello');

    expect(first.sentinel).not.toBe(second.sentinel);
    expect(first.command).toContain('printf hello');
    expect(parseRcSentinel(`hello\n${first.sentinel} 0\n`, first.sentinel)).toEqual({
      exitCode: 0,
      stdout: 'hello',
    });
  });

  it('preserves a command trailing newline and non-zero exit code', () => {
    const wrapped = wrapWithRcSentinel('false');
    expect(parseRcSentinel(`failed\n\n${wrapped.sentinel} 7\n`, wrapped.sentinel)).toEqual({
      exitCode: 7,
      stdout: 'failed\n',
    });
  });

  it('ignores output without the matching final marker', () => {
    const wrapped = wrapWithRcSentinel('echo ok');
    expect(parseRcSentinel(`${wrapped.sentinel} 0\nstill running`, wrapped.sentinel)).toBeNull();
    expect(parseRcSentinel('__AGENTBOX_ISLO_RC_other__ 0\n', wrapped.sentinel)).toBeNull();
  });
});
