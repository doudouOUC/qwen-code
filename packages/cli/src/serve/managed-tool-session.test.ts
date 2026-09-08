/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config, ManagedToolV2Client } from '@qwen-code/qwen-code-core';
import type { ManagedRuntimeProvider } from './managed-runtime-provider.js';
import { createManagedToolSessionFactory } from './managed-tool-session.js';
import { createWorkspaceGenerationGuard } from './workspace-registry.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe('managed tool Session binding', () => {
  let cwd: string;
  let guard: ReturnType<typeof createWorkspaceGenerationGuard>;
  const client = {} as ManagedToolV2Client;
  const getClient =
    vi.fn<NonNullable<ManagedRuntimeProvider['getToolV2Client']>>();
  const release = vi.fn<ManagedRuntimeProvider['release']>();
  const provider = {
    getToolV2Client: getClient,
    release,
  } as unknown as ManagedRuntimeProvider;

  beforeEach(async () => {
    cwd = await realpath(
      await mkdtemp(join(tmpdir(), 'managed-tool-session-')),
    );
    guard = createWorkspaceGenerationGuard();
    getClient.mockReset().mockResolvedValue(client);
    release.mockReset().mockResolvedValue(true);
  });
  afterEach(async () => {
    guard.close();
    await rm(cwd, { recursive: true, force: true });
  });
  function create(trusted = true) {
    return createManagedToolSessionFactory({
      provider,
      tenantId: 'tenant',
      workspaceId: 'workspace',
      workspaceCwd: cwd,
      workspaceTrusted: trusted,
      generationGuard: guard,
      shellConfiguration: {
        shell: 'bash',
        executable: 'bash',
        argsPrefix: ['-c'],
      },
      platform: 'darwin',
    })({ getTargetDir: () => cwd } as Config);
  }

  it('does not acquire a worker for declaration-only and replay Configs', async () => {
    const session = create();
    await session.close();
    expect(getClient).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    expect(() => session.getClient()).toThrow('closing');
  });

  it('coalesces acquisition and binds independent Runtime Session identities', async () => {
    const first = create();
    const second = create();
    expect(first.sessionId).not.toBe(second.sessionId);
    expect(await Promise.all([first.getClient(), first.getClient()])).toEqual([
      client,
      client,
    ]);
    await second.getClient();
    expect(getClient).toHaveBeenCalledTimes(2);
    expect(getClient).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        tenantId: 'tenant',
        workspaceId: 'workspace',
        workspaceCwd: cwd,
        sessionId: first.sessionId,
      }),
    );
    await first.close();
    expect(release).toHaveBeenCalledWith(
      first.sessionId,
      getClient.mock.calls[0][0],
      { terminal: true },
    );
    await second.close();
  });

  it('awaits late acquisition and real release, retaining a failed close for retry', async () => {
    const acquired = deferred<ManagedToolV2Client>();
    const released = deferred<boolean>();
    getClient.mockReturnValue(acquired.promise);
    release.mockReturnValueOnce(released.promise);
    const session = create();
    const pending = session.getClient();
    const rejectedAcquisition = pending.catch((error: unknown) => error);
    await vi.waitFor(() => expect(getClient).toHaveBeenCalledOnce());
    const close = session.close();
    expect(session.close()).toBe(close);
    const rejectedClose = close.catch((error: unknown) => error);
    expect(release).not.toHaveBeenCalled();
    acquired.resolve(client);
    expect(await rejectedAcquisition).toMatchObject({
      message: 'Managed tool Session is closing.',
    });
    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
    released.reject(new Error('not contained'));
    expect(await rejectedClose).toMatchObject({ message: 'not contained' });
    expect(() => session.getClient()).toThrow('closing');
    await session.close();
    expect(release).toHaveBeenCalledTimes(2);
  });

  it('releases a Session even when acquisition fails after dispatch', async () => {
    getClient.mockRejectedValue(new Error('reply lost'));
    const session = create();
    await expect(session.getClient()).rejects.toThrow('reply lost');
    await session.close();
    expect(release).toHaveBeenCalledWith(
      session.sessionId,
      expect.objectContaining({ sessionId: session.sessionId }),
      { terminal: true },
    );
  });

  it('does not claim cleanup from an unproven false response', async () => {
    release.mockResolvedValueOnce(false);
    const session = create();
    await session.getClient();
    await expect(session.close()).rejects.toThrow('unproven');
    await session.close();
  });

  it('checks admission before using even an already acquired client', async () => {
    const session = create();
    await session.getClient();
    guard.close();
    expect(() => session.getClient()).toThrow();
    await session.close();
    expect(release).toHaveBeenCalledOnce();
  });

  it('rejects an untrusted workspace before contacting the provider', async () => {
    const session = create(false);
    expect(() => session.getClient()).toThrow('workspace binding');
    await session.close();
    expect(getClient).not.toHaveBeenCalled();
  });
});
