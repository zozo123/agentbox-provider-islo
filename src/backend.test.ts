import { UserFacingError } from '@madarco/agentbox-provider-sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const sandboxes = {
    createSandbox: vi.fn(),
    getSandbox: vi.fn(),
    listSandboxes: vi.fn(),
    resumeSandbox: vi.fn(),
    stopSandbox: vi.fn(),
    pauseSandbox: vi.fn(),
    deleteSandbox: vi.fn(),
    execInSandbox: vi.fn(),
    getExecResult: vi.fn(),
  };
  const shares = {
    listShares: vi.fn(),
    createShare: vi.fn(),
    revokeShare: vi.fn(),
  };
  return { client: { sandboxes, shares }, sandboxes, shares };
});

vi.mock('./islo.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./islo.js')>();
  return { ...actual, getClient: () => mocks.client };
});

import { DEFAULT_BOX_IMAGE_REF, isloBackend } from './backend.js';

describe('islo backend regressions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sandboxes.getSandbox.mockResolvedValue({ status: 'running' });
    mocks.shares.listShares.mockResolvedValue([]);
  });

  it('finishes a streamed exec when the process tree remains running', async () => {
    let command = '';
    mocks.sandboxes.execInSandbox.mockImplementation(async (request) => {
      command = request.command[2];
      return { exec_id: 'exec-1' };
    });
    mocks.sandboxes.getExecResult.mockImplementation(async () => {
      const sentinel = /(__AGENTBOX_ISLO_RC_[a-f0-9]+__)/.exec(command)?.[1];
      return {
        status: 'running',
        exit_code: null,
        stdout: `ctl ready\n\n${sentinel} 0\n`,
        stderr: '',
        truncated: false,
      };
    });

    await expect(isloBackend.exec({ sandboxId: 'box' }, 'agentbox-ctl bootstrap')).resolves.toEqual({
      exitCode: 0,
      stdout: 'ctl ready\n',
      stderr: '',
    });
    expect(command).toContain('agentbox-ctl bootstrap');
  });

  it('maps an ambiguous create 503 to actionable tombstone and image guidance', async () => {
    mocks.sandboxes.createSandbox.mockRejectedValue(
      Object.assign(new Error('RESOURCE_UNAVAILABLE'), { statusCode: 503 }),
    );

    const result = isloBackend.provision({ name: 'reused-box', image: 'large/image:latest' });
    await expect(result).rejects.toBeInstanceOf(UserFacingError);
    await expect(result).rejects.toThrow(/recently deleted.*image-size limit/i);
  });

  it('keeps retrying resume while archival state settles', async () => {
    vi.useFakeTimers();
    mocks.sandboxes.getSandbox
      .mockResolvedValueOnce({ status: 'paused' })
      .mockResolvedValue({ status: 'running' });
    mocks.sandboxes.resumeSandbox
      .mockRejectedValueOnce(Object.assign(new Error('settling'), { statusCode: 500 }))
      .mockRejectedValueOnce(Object.assign(new Error('settling'), { statusCode: 500 }))
      .mockResolvedValue({ status: 'running' });

    const resumed = isloBackend.resume({ sandboxId: 'box' });
    await vi.runAllTimersAsync();
    await resumed;

    expect(mocks.sandboxes.resumeSandbox).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it('returns the public share as a signed browser URL', async () => {
    mocks.shares.createShare.mockResolvedValue({ url: 'https://share.islo.dev/box' });

    await expect(
      isloBackend.signedPreviewUrl?.({ sandboxId: 'box' }, 8080, 3600),
    ).resolves.toEqual({ url: 'https://share.islo.dev/box' });
  });

  it('keeps the AgentBox sentinel image mapped to the provider default', async () => {
    mocks.sandboxes.createSandbox.mockResolvedValue({ status: 'running' });
    await isloBackend.provision({ name: 'box', image: DEFAULT_BOX_IMAGE_REF });

    expect(mocks.sandboxes.createSandbox).toHaveBeenCalledWith(
      expect.not.objectContaining({ image: expect.anything() }),
    );
  });
});
