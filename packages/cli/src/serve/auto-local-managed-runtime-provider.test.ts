/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AutoLocalManagedRuntimeProvider } from './auto-local-managed-runtime-provider.js';
import {
  ManagedRuntimeReleasedError,
  type ManagedRuntimeEndpoint,
} from './managed-runtime-activator.js';
import type { LocalProcessRuntimeActivator } from './local-process-runtime-activator.js';
import type {
  WorkspaceRegistry,
  WorkspaceRuntime,
} from './workspace-registry.js';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const request = {
  protocolVersion: 1 as const,
  tenantId: 'tenant',
  workspaceId: 'workspace',
  workspaceCwd: '/tmp',
  sessionId: '550e8400-e29b-41d4-a716-446655440108',
  turnKind: 'bootstrap' as const,
};
function endpoint(leaseId: string): ManagedRuntimeEndpoint {
  return {
    url: 'http://127.0.0.1:12345',
    deadline: Date.now() + 1000,
    boot: {
      ...request,
      version: 1,
      type: 'boot',
      leaseId,
      epoch: 1,
      gatewayIncarnation: 'gateway',
      token: 'secret',
      cliEntry: '/cli.js',
      outputRoot: '/tmp/owned',
    },
  };
}
function setup() {
  const runtime = {
    workspaceId: request.workspaceId,
    workspaceCwd: request.workspaceCwd,
    trusted: true,
  } as WorkspaceRuntime;
  const registry = {
    getByWorkspaceId: () => runtime,
  } as unknown as WorkspaceRegistry;
  const activate = vi.fn();
  const lost = vi.fn();
  const activator = {
    activate,
    close: vi.fn(async () => {}),
  } as unknown as LocalProcessRuntimeActivator;
  const provider = new AutoLocalManagedRuntimeProvider(
    registry,
    activator,
    lost,
  );
  return { activate, lost, provider };
}
function use(promise = Promise.resolve(endpoint('one'))) {
  const controller = new AbortController();
  const release = vi.fn();
  const finished = vi.fn();
  return {
    controller,
    endpoint: promise,
    signal: controller.signal,
    release,
    beginOperation: vi.fn(() => finished),
    finished,
  };
}
afterEach(() => vi.unstubAllGlobals());
describe('AutoLocal Managed Runtime provider', () => {
  it('returns immediately while the worker is pending and releases only the dispatch use', async () => {
    const { provider, activate } = setup();
    const pending = deferred<ManagedRuntimeEndpoint>();
    const active = use(pending.promise);
    activate.mockReturnValue(active);
    const fetch = vi.fn(async () =>
      Response.json({ protocolVersion: 1, ready: true }),
    );
    vi.stubGlobal('fetch', fetch);
    const handle = provider.prepare(request);
    handle.finish('completed');
    expect(active.release).toHaveBeenCalledWith('completed');
    expect(fetch).not.toHaveBeenCalled();
    pending.resolve(endpoint('one'));
    await handle.ready;
    expect(fetch).toHaveBeenCalledOnce();
    await provider.dispose();
  });
  it('does not attribute an old generation death to a replacement Session binding', async () => {
    const { provider, activate, lost } = setup();
    const first = use();
    const second = use(Promise.resolve(endpoint('two')));
    activate.mockReturnValueOnce(first).mockReturnValueOnce(second);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ protocolVersion: 1, ready: true })),
    );
    const oldHandle = provider.prepare(request);
    await oldHandle.ready;
    const newHandle = provider.prepare({
      ...request,
      turnKind: 'continuation',
    });
    await newHandle.ready;
    first.controller.abort(new ManagedRuntimeReleasedError('evicted'));
    expect(lost).not.toHaveBeenCalled();
    second.controller.abort(new Error('worker died'));
    expect(lost).toHaveBeenCalledOnce();
    expect(lost.mock.calls[0]?.[1]).toBe(false);
    await expect(
      oldHandle.getManifest(new AbortController().signal),
    ).rejects.toThrow('evicted');
    await provider.dispose();
  });
  it('retires uncertain execution once, never retries it and excludes late results', async () => {
    const { provider, activate } = setup();
    const active = use();
    activate.mockReturnValue(active);
    const dispatched = deferred<void>();
    const late = deferred<Response>();
    const fetch = vi.fn(async (url: URL) => {
      if (url.pathname.endsWith('/execute')) {
        dispatched.resolve();
        return late.promise;
      }
      return Response.json({ protocolVersion: 1, ready: true });
    });
    vi.stubGlobal('fetch', fetch);
    const handle = provider.prepare(request);
    await handle.ready;
    const abort = new AbortController();
    const result = handle.execute(
      {
        executionId: 'execution',
        turnId: 'turn',
        toolCallId: 'tool',
        capabilityDigest: 'digest',
        toolName: 'read_file',
        input: {},
      },
      abort.signal,
    );
    await dispatched.promise;
    abort.abort(new Error('cancelled'));
    late.resolve(
      Response.json({
        protocolVersion: 1,
        result: { executionStatus: 'success', responseParts: [] },
      }),
    );
    await expect(result).rejects.toThrow('cancelled');
    expect(active.finished).toHaveBeenCalledExactlyOnceWith(false);
    expect(
      fetch.mock.calls.filter(([url]) => url.pathname.endsWith('/execute')),
    ).toHaveLength(1);
    handle.finish('cancelled');
    await provider.dispose();
  });
});
