/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  RemoteManagedRuntimeProvider,
  ManagedRuntimeProviderError,
  type ManagedRuntimeProvider,
  type ManagedRuntimeHandle,
} from './managed-runtime-provider.js';
import {
  ManagedRuntimeReleasedError,
  type ManagedRuntimeUse,
} from './managed-runtime-activator.js';
import {
  sameManagedRuntimeIdentity,
  type ManagedRuntimePrepareRequest,
} from './managed-runtime-protocol.js';
import type { LocalProcessRuntimeActivator } from './local-process-runtime-activator.js';
import type { WorkspaceRegistry } from './workspace-registry.js';

interface Binding {
  readonly request: ManagedRuntimePrepareRequest;
  readonly use: ManagedRuntimeUse;
  readonly handle: Promise<ManagedRuntimeHandle>;
  delegate?: RemoteManagedRuntimeProvider;
  unsubscribe?: () => void;
}
export class AutoLocalManagedRuntimeProvider implements ManagedRuntimeProvider {
  private readonly delegates = new Map<string, RemoteManagedRuntimeProvider>();
  private readonly bindings = new Map<string, Binding>();
  private disposed = false;
  constructor(
    private readonly registry: WorkspaceRegistry,
    readonly activator: LocalProcessRuntimeActivator,
    private readonly onLost: (
      request: ManagedRuntimePrepareRequest,
      released: boolean,
    ) => void,
  ) {}

  prepare(request: ManagedRuntimePrepareRequest): ManagedRuntimeHandle {
    const runtime = this.registry.getByWorkspaceId(request.workspaceId);
    if (
      this.disposed ||
      !runtime?.trusted ||
      runtime.workspaceCwd !== request.workspaceCwd ||
      runtime.generationGuard?.closed
    )
      throw new ManagedRuntimeProviderError(
        'managed_runtime_identity_conflict',
        'Managed Runtime workspace binding is unavailable.',
        false,
      );
    const previous = this.bindings.get(request.sessionId);
    if (previous && !sameManagedRuntimeIdentity(previous.request, request))
      throw new ManagedRuntimeProviderError(
        'managed_runtime_identity_conflict',
        'Managed Runtime Session identity changed.',
        false,
      );
    previous?.unsubscribe?.();
    const use = this.activator.activate({
      tenantId: request.tenantId,
      runtime,
    });
    const handle = use.endpoint.then((endpoint) => {
      use.signal.throwIfAborted();
      let delegate = this.delegates.get(endpoint.boot.leaseId);
      if (!delegate) {
        delegate = new RemoteManagedRuntimeProvider({
          baseUrl: endpoint.url,
          token: endpoint.boot.token,
          lease: endpoint.boot,
          prepareRetryWindowMs: Math.max(0, endpoint.deadline - Date.now()),
        });
        this.delegates.set(endpoint.boot.leaseId, delegate);
        const captured = delegate;
        use.signal.addEventListener(
          'abort',
          () => {
            captured.dispose();
            this.delegates.delete(endpoint.boot.leaseId);
          },
          { once: true },
        );
      }
      binding.delegate = delegate;
      return delegate.prepare(
        request,
        Math.max(0, endpoint.deadline - Date.now()),
      );
    });
    const binding: Binding = { request: structuredClone(request), use, handle };
    this.bindings.set(request.sessionId, binding);
    const onAbort = () => {
      if (this.bindings.get(request.sessionId) !== binding) return;
      this.bindings.delete(request.sessionId);
      if (!this.disposed)
        this.onLost(
          request,
          use.signal.reason instanceof ManagedRuntimeReleasedError,
        );
    };
    use.signal.addEventListener('abort', onAbort, { once: true });
    binding.unsubscribe = () =>
      use.signal.removeEventListener('abort', onAbort);
    const ready = handle
      .then((h) => h.ready)
      .then(() => {
        use.signal.throwIfAborted();
      });
    void ready.catch(() => {});
    const operation = (signal: AbortSignal) =>
      AbortSignal.any([signal, use.signal]);
    return {
      ready,
      finish: (reason) => use.release(reason),
      getManifest: async (signal) => {
        const combined = operation(signal);
        const h = await this.wait(handle, combined);
        combined.throwIfAborted();
        const manifest = await h.getManifest(combined);
        combined.throwIfAborted();
        return manifest;
      },
      execute: async (request, signal) => {
        const combined = operation(signal);
        const h = await this.wait(handle, combined);
        await this.wait(ready, combined);
        combined.throwIfAborted();
        const finish = use.beginOperation();
        try {
          const result = await h.execute(request, combined);
          combined.throwIfAborted();
          finish(true);
          return result;
        } catch (error) {
          finish(false);
          throw error;
        }
      },
    };
  }
  async cancel(
    sessionId: string,
    executionId: string,
    expected?: ManagedRuntimePrepareRequest,
  ): Promise<boolean> {
    const binding = this.bound(sessionId, expected);
    if (!binding?.delegate) return false;
    return binding.delegate.cancel(sessionId, executionId, expected);
  }
  async release(
    sessionId: string,
    expected?: ManagedRuntimePrepareRequest,
  ): Promise<boolean> {
    const binding = this.bound(sessionId, expected);
    if (!binding) return false;
    this.bindings.delete(sessionId);
    binding.unsubscribe?.();
    binding.use.release('cancelled');
    await binding.handle.catch(() => undefined);
    return binding.delegate?.release(sessionId, binding.request) ?? false;
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    const closing = this.activator.close();
    for (const delegate of this.delegates.values()) delegate.dispose();
    this.bindings.clear();
    await closing;
    this.delegates.clear();
  }
  private bound(
    sessionId: string,
    expected?: ManagedRuntimePrepareRequest,
  ): Binding | undefined {
    const binding = this.bindings.get(sessionId);
    if (
      binding &&
      expected &&
      !sameManagedRuntimeIdentity(binding.request, expected)
    )
      throw new ManagedRuntimeProviderError(
        'managed_runtime_identity_conflict',
        'Managed Runtime Session identity changed.',
        false,
      );
    return binding;
  }
  private async wait<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted();
    let abort: () => void = () => {};
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          abort = () => reject(signal.reason);
          signal.addEventListener('abort', abort, { once: true });
        }),
      ]);
    } finally {
      signal.removeEventListener('abort', abort);
    }
  }
}
