/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  BridgeManagedRuntimeToolExecuteRequest,
  BridgeManagedRuntimeToolExecuteResult,
  BridgeManagedRuntimeToolManifest,
} from '@qwen-code/acp-bridge/bridgeTypes';
import type { AcpSessionBridge } from './acp-session-bridge.js';
import { isLoopbackBind } from './loopback-binds.js';
import type { ManagedGatewayToolRuntime } from './managed-gateway-model-runtime.js';
import {
  MANAGED_RUNTIME_PROTOCOL_VERSION,
  MANAGED_RUNTIME_ROUTE_PREFIX,
  type ManagedRuntimeCancelResponse,
  type ManagedRuntimeExecuteResponse,
  type ManagedRuntimeManifestResponse,
  type ManagedRuntimePrepareRequest,
  type ManagedRuntimeReadyResponse,
  type ManagedRuntimeReleaseResponse,
  sameManagedRuntimeIdentity,
} from './managed-runtime-protocol.js';
import type {
  WorkspaceRegistry,
  WorkspaceRuntime,
} from './workspace-registry.js';

const MAX_REMOTE_MANIFEST_BYTES = 1024 * 1024;
const MAX_REMOTE_TOOL_RESULT_BYTES = 8 * 1024 * 1024;
const MAX_REMOTE_CONTROL_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_PREPARE_RETRY_WINDOW_MS = 5 * 60_000;
const DEFAULT_PREPARE_RETRY_DELAY_MS = 100;
const DEFAULT_PREPARE_RETRY_MAX_DELAY_MS = 2_000;
const CONTROL_REQUEST_TIMEOUT_MS = 5_000;

type BridgeSession = Awaited<ReturnType<AcpSessionBridge['spawnOrAttach']>>;

export interface ManagedRuntimeHandle extends ManagedGatewayToolRuntime {
  readonly ready: Promise<void>;
}

export interface ManagedRuntimeProvider {
  prepare(request: ManagedRuntimePrepareRequest): ManagedRuntimeHandle;
  cancel(
    sessionId: string,
    executionId: string,
    expected?: ManagedRuntimePrepareRequest,
  ): Promise<boolean>;
  release(
    sessionId: string,
    expected?: ManagedRuntimePrepareRequest,
  ): Promise<boolean>;
  dispose(): void;
}

export class ManagedRuntimeProviderError extends Error {
  constructor(
    readonly code:
      | 'managed_runtime_identity_conflict'
      | 'managed_runtime_unavailable'
      | 'managed_runtime_disposed',
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'ManagedRuntimeProviderError';
  }
}

interface LocalBinding {
  readonly request: ManagedRuntimePrepareRequest;
  readonly runtime: WorkspaceRuntime;
  readonly runtimeClientId: string;
  readonly controller: AbortController;
}

interface LocalWarmup {
  readonly request: ManagedRuntimePrepareRequest;
  readonly runtime: WorkspaceRuntime;
  readonly controller: AbortController;
  readonly promise: Promise<LocalBinding>;
}

class ManagedRuntimeReleaseAbortError extends Error {
  constructor() {
    super('Managed Runtime Session released.');
    this.name = 'ManagedRuntimeReleaseAbortError';
  }
}

function abortError(signal: AbortSignal, fallback: string): unknown {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException(fallback, 'AbortError');
}

function waitForValue<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(abortError(signal, 'Managed Runtime wait aborted.'));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(abortError(signal, 'Managed Runtime wait aborted.'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void pending.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

async function cleanupLocalSession(
  bridge: AcpSessionBridge,
  session: BridgeSession,
): Promise<void> {
  if (session.attached && session.clientId) {
    await bridge
      .detachClient(session.sessionId, session.clientId)
      .catch(() => undefined);
    return;
  }
  await bridge
    .closeSession(
      session.sessionId,
      session.clientId ? { clientId: session.clientId } : undefined,
    )
    .catch(() => undefined);
}

function waitForLocalSession(
  bridge: AcpSessionBridge,
  pending: Promise<BridgeSession>,
  request: ManagedRuntimePrepareRequest,
  signal: AbortSignal,
  allowAttached: boolean,
): Promise<{ session: BridgeSession; runtimeClientId: string }> {
  if (signal.aborted) {
    return Promise.reject(abortError(signal, 'Runtime preparation aborted.'));
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      if (signal.reason instanceof ManagedRuntimeReleaseAbortError) return;
      reject(abortError(signal, 'Runtime preparation aborted.'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void pending.then(
      async (session) => {
        signal.removeEventListener('abort', onAbort);
        const matchesIdentity =
          session.sessionId === request.sessionId &&
          session.workspaceCwd === request.workspaceCwd &&
          session.sourceType === 'managed-gateway' &&
          session.sourceId === request.sessionId;
        const valid =
          !signal.aborted &&
          (allowAttached || !session.attached) &&
          matchesIdentity &&
          session.hasActivePrompt !== true &&
          Boolean(session.clientId);
        if (!valid) {
          if (
            signal.reason instanceof ManagedRuntimeReleaseAbortError &&
            matchesIdentity &&
            session.clientId
          ) {
            await bridge
              .closeSession(
                session.sessionId,
                session.clientId ? { clientId: session.clientId } : undefined,
              )
              .catch(() => undefined);
          } else {
            await cleanupLocalSession(bridge, session);
          }
          reject(
            signal.aborted
              ? abortError(signal, 'Runtime preparation aborted.')
              : new ManagedRuntimeProviderError(
                  'managed_runtime_identity_conflict',
                  'Managed Runtime Session identity did not match its binding.',
                  false,
                ),
          );
          return;
        }
        resolve({ session, runtimeClientId: session.clientId! });
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function isSessionNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'session_not_found'
  );
}

export class LocalManagedRuntimeProvider implements ManagedRuntimeProvider {
  private readonly bindings = new Map<string, LocalBinding>();
  private readonly warmups = new Map<string, LocalWarmup>();
  private readonly lifetime = new AbortController();

  constructor(private readonly workspaceRegistry: WorkspaceRegistry) {}

  prepare(request: ManagedRuntimePrepareRequest): ManagedRuntimeHandle {
    if (this.lifetime.signal.aborted) {
      throw new ManagedRuntimeProviderError(
        'managed_runtime_disposed',
        'Managed Runtime provider is disposed.',
        false,
      );
    }
    const runtime = this.workspaceRegistry.getByWorkspaceId(
      request.workspaceId,
    );
    if (!runtime || !runtime.trusted) {
      throw new ManagedRuntimeProviderError(
        'managed_runtime_unavailable',
        'Managed Runtime workspace is unavailable or untrusted.',
        true,
      );
    }
    if (runtime.workspaceCwd !== request.workspaceCwd) {
      throw new ManagedRuntimeProviderError(
        'managed_runtime_identity_conflict',
        'Managed Runtime workspace identity changed.',
        false,
      );
    }
    const readyBinding = this.startWarmup(runtime, request);
    return {
      ready: readyBinding.then(() => undefined),
      getManifest: async (signal) => {
        const binding = await waitForValue(readyBinding, signal);
        const operationSignal = AbortSignal.any([
          signal,
          binding.controller.signal,
          this.lifetime.signal,
        ]);
        operationSignal.throwIfAborted();
        return waitForValue(
          binding.runtime.bridge.getManagedRuntimeToolManifest(
            request.sessionId,
            { clientId: binding.runtimeClientId },
          ),
          operationSignal,
        );
      },
      execute: async (toolRequest, signal) => {
        const binding = await waitForValue(readyBinding, signal);
        const operationSignal = AbortSignal.any([
          signal,
          binding.controller.signal,
          this.lifetime.signal,
        ]);
        operationSignal.throwIfAborted();
        return binding.runtime.bridge.executeManagedRuntimeTool(
          request.sessionId,
          toolRequest,
          operationSignal,
          { clientId: binding.runtimeClientId },
        );
      },
    };
  }

  async cancel(
    sessionId: string,
    executionId: string,
    expected?: ManagedRuntimePrepareRequest,
  ): Promise<boolean> {
    const binding = this.bindings.get(sessionId);
    const warmup = this.warmups.get(sessionId);
    const current = binding?.request ?? warmup?.request;
    if (expected && current && !sameManagedRuntimeIdentity(current, expected)) {
      throw new ManagedRuntimeProviderError(
        'managed_runtime_identity_conflict',
        'Managed Runtime Session identity changed.',
        false,
      );
    }
    if (!binding) return false;
    const result = await binding.runtime.bridge.cancelManagedRuntimeTool(
      sessionId,
      executionId,
      { clientId: binding.runtimeClientId },
    );
    return result.cancelled;
  }

  async release(
    sessionId: string,
    expected?: ManagedRuntimePrepareRequest,
  ): Promise<boolean> {
    const warmup = this.warmups.get(sessionId);
    const binding = this.bindings.get(sessionId);
    const current = warmup?.request ?? binding?.request;
    if (expected && current && !sameManagedRuntimeIdentity(current, expected)) {
      throw new ManagedRuntimeProviderError(
        'managed_runtime_identity_conflict',
        'Managed Runtime Session identity changed.',
        false,
      );
    }
    this.warmups.delete(sessionId);
    this.bindings.delete(sessionId);
    warmup?.controller.abort(new ManagedRuntimeReleaseAbortError());
    if (binding) {
      binding.controller.abort(new ManagedRuntimeReleaseAbortError());
      await binding.runtime.bridge
        .closeSession(sessionId, { clientId: binding.runtimeClientId })
        .catch(() => undefined);
      return true;
    }
    if (warmup) {
      const resolved = await warmup.promise.catch(() => undefined);
      if (resolved) {
        resolved.controller.abort(new ManagedRuntimeReleaseAbortError());
        await resolved.runtime.bridge
          .closeSession(sessionId, { clientId: resolved.runtimeClientId })
          .catch(() => undefined);
      }
      return true;
    }
    if (expected && !this.lifetime.signal.aborted) {
      const runtime = this.workspaceRegistry.getByWorkspaceId(
        expected.workspaceId,
      );
      if (!runtime || !runtime.trusted) {
        throw new ManagedRuntimeProviderError(
          'managed_runtime_unavailable',
          'Managed Runtime workspace is unavailable or untrusted.',
          true,
        );
      }
      if (runtime.workspaceCwd !== expected.workspaceCwd) {
        throw new ManagedRuntimeProviderError(
          'managed_runtime_identity_conflict',
          'Managed Runtime workspace identity changed.',
          false,
        );
      }
      try {
        const restored = await waitForLocalSession(
          runtime.bridge,
          runtime.bridge.resumeSession({
            sessionId,
            workspaceCwd: expected.workspaceCwd,
            sourceType: 'managed-gateway',
            sourceId: sessionId,
          }),
          expected,
          this.lifetime.signal,
          true,
        );
        await runtime.bridge.closeSession(sessionId, {
          clientId: restored.runtimeClientId,
        });
        return true;
      } catch (error) {
        if (isSessionNotFound(error)) return false;
        throw error;
      }
    }
    return false;
  }

  dispose(): void {
    if (this.lifetime.signal.aborted) return;
    this.lifetime.abort(new Error('Managed Runtime provider disposed.'));
    for (const warmup of this.warmups.values()) {
      warmup.controller.abort(new Error('Managed Runtime provider disposed.'));
    }
    for (const binding of this.bindings.values()) {
      binding.controller.abort(new Error('Managed Runtime provider disposed.'));
    }
    this.warmups.clear();
    this.bindings.clear();
  }

  private startWarmup(
    runtime: WorkspaceRuntime,
    request: ManagedRuntimePrepareRequest,
  ): Promise<LocalBinding> {
    const existingWarmup = this.warmups.get(request.sessionId);
    if (existingWarmup) {
      if (
        existingWarmup.runtime !== runtime ||
        !sameManagedRuntimeIdentity(existingWarmup.request, request)
      ) {
        throw new ManagedRuntimeProviderError(
          'managed_runtime_identity_conflict',
          'Managed Runtime warmup changed Session identity.',
          false,
        );
      }
      return existingWarmup.promise;
    }

    const controller = new AbortController();
    const signal = AbortSignal.any([this.lifetime.signal, controller.signal]);
    const promise = this.prepareBinding(runtime, request, signal, controller);
    const warmup: LocalWarmup = { request, runtime, controller, promise };
    this.warmups.set(request.sessionId, warmup);
    void promise.then(
      (binding) => {
        if (signal.aborted || this.warmups.get(request.sessionId) !== warmup) {
          return;
        }
        this.warmups.delete(request.sessionId);
        this.bindings.set(request.sessionId, binding);
      },
      () => {
        if (this.warmups.get(request.sessionId) === warmup) {
          this.warmups.delete(request.sessionId);
        }
      },
    );
    return promise;
  }

  private async prepareBinding(
    runtime: WorkspaceRuntime,
    request: ManagedRuntimePrepareRequest,
    signal: AbortSignal,
    controller: AbortController,
  ): Promise<LocalBinding> {
    const cached = this.bindings.get(request.sessionId);
    if (cached) {
      if (!sameManagedRuntimeIdentity(cached.request, request)) {
        this.forgetBinding(request.sessionId, cached);
        throw new ManagedRuntimeProviderError(
          'managed_runtime_identity_conflict',
          'Managed Runtime live Session identity changed.',
          false,
        );
      }
      if (cached.runtime !== runtime) {
        this.forgetBinding(request.sessionId, cached);
      } else {
        let summary:
          | ReturnType<AcpSessionBridge['getSessionSummary']>
          | undefined;
        try {
          summary = runtime.bridge.getSessionSummary(request.sessionId);
        } catch {
          this.forgetBinding(request.sessionId, cached);
        }
        if (
          summary &&
          (summary.workspaceCwd !== request.workspaceCwd ||
            summary.sourceType !== 'managed-gateway' ||
            summary.sourceId !== request.sessionId)
        ) {
          this.forgetBinding(request.sessionId, cached);
          throw new ManagedRuntimeProviderError(
            'managed_runtime_identity_conflict',
            'Managed Runtime live Session identity changed.',
            false,
          );
        }
        if (summary) {
          if (summary.hasActivePrompt) {
            this.forgetBinding(request.sessionId, cached);
            throw new ManagedRuntimeProviderError(
              'managed_runtime_identity_conflict',
              'Managed Runtime already has an active Prompt.',
              false,
            );
          }
          try {
            runtime.bridge.recordHeartbeat(request.sessionId, {
              clientId: cached.runtimeClientId,
            });
            return cached;
          } catch {
            this.forgetBinding(request.sessionId, cached);
          }
        }
      }
    }

    const waitForSession = (
      pending: Promise<BridgeSession>,
      allowAttached: boolean,
    ) =>
      waitForLocalSession(
        runtime.bridge,
        pending,
        request,
        signal,
        allowAttached,
      );
    let result: Awaited<ReturnType<typeof waitForSession>>;
    if (request.turnKind === 'continuation') {
      try {
        result = await waitForSession(
          runtime.bridge.resumeSession({
            sessionId: request.sessionId,
            workspaceCwd: request.workspaceCwd,
            sourceType: 'managed-gateway',
            sourceId: request.sessionId,
          }),
          true,
        );
      } catch (error) {
        if (!isSessionNotFound(error)) throw error;
        result = await waitForSession(
          runtime.bridge.spawnOrAttach({
            workspaceCwd: request.workspaceCwd,
            sessionScope: 'thread',
            sessionId: request.sessionId,
            sourceType: 'managed-gateway',
            sourceId: request.sessionId,
          }),
          false,
        );
      }
    } else {
      result = await waitForSession(
        runtime.bridge.spawnOrAttach({
          workspaceCwd: request.workspaceCwd,
          sessionScope: 'thread',
          sessionId: request.sessionId,
          sourceType: 'managed-gateway',
          sourceId: request.sessionId,
        }),
        false,
      );
    }
    return {
      request: structuredClone(request),
      runtime,
      runtimeClientId: result.runtimeClientId,
      controller,
    };
  }

  private forgetBinding(sessionId: string, binding: LocalBinding): void {
    if (this.bindings.get(sessionId) === binding) {
      this.bindings.delete(sessionId);
    }
    binding.controller.abort(new Error('Managed Runtime binding changed.'));
  }
}

interface RemoteProviderEntry {
  request: ManagedRuntimePrepareRequest;
  readonly controller: AbortController;
  readonly ready: Promise<void>;
}

class RemoteResponseError extends Error {
  constructor(readonly status: number) {
    super(`Managed Runtime returned HTTP ${status}.`);
    this.name = 'RemoteResponseError';
  }
}

export interface RemoteManagedRuntimeProviderOptions {
  readonly baseUrl: string;
  readonly token: string;
  readonly fetch?: typeof fetch;
  readonly prepareRetryWindowMs?: number;
  readonly prepareRetryDelayMs?: number;
  readonly prepareRetryMaxDelayMs?: number;
}

function resolveRemoteBaseUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Managed Runtime URL is invalid.');
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== '/' && url.pathname !== '')
  ) {
    throw new Error('Managed Runtime URL must be an HTTP(S) origin.');
  }
  if (url.protocol === 'http:' && !isLoopbackBind(url.hostname)) {
    throw new Error(
      'Managed Runtime URL must use HTTPS outside the loopback interface.',
    );
  }
  url.pathname = '/';
  return url;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(abortError(signal, 'Managed Runtime retry aborted.'));
  }
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    timer.unref();
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(abortError(signal, 'Managed Runtime retry aborted.'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function validRetryOption(
  value: number | undefined,
  fallback: number,
  minimum: number,
): number {
  return value !== undefined && Number.isFinite(value) && value >= minimum
    ? value
    : fallback;
}

async function readBoundedResponseText(
  response: Response,
  maxResponseBytes: number,
): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      totalBytes += chunk.value.byteLength;
      if (totalBytes > maxResponseBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error('Managed Runtime response exceeded its size limit.');
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, totalBytes).toString('utf8');
}

export class RemoteManagedRuntimeProvider implements ManagedRuntimeProvider {
  private readonly baseUrl: URL;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly retryWindowMs: number;
  private readonly retryDelayMs: number;
  private readonly retryMaxDelayMs: number;
  private readonly entries = new Map<string, RemoteProviderEntry>();
  private readonly lifetime = new AbortController();

  constructor(options: RemoteManagedRuntimeProviderOptions) {
    this.baseUrl = resolveRemoteBaseUrl(options.baseUrl);
    this.token = options.token.trim();
    if (!this.token) throw new Error('Managed Runtime token is required.');
    this.fetchImpl = options.fetch ?? fetch;
    this.retryWindowMs = validRetryOption(
      options.prepareRetryWindowMs,
      DEFAULT_PREPARE_RETRY_WINDOW_MS,
      0,
    );
    this.retryDelayMs = validRetryOption(
      options.prepareRetryDelayMs,
      DEFAULT_PREPARE_RETRY_DELAY_MS,
      0,
    );
    this.retryMaxDelayMs = validRetryOption(
      options.prepareRetryMaxDelayMs,
      DEFAULT_PREPARE_RETRY_MAX_DELAY_MS,
      1,
    );
  }

  prepare(request: ManagedRuntimePrepareRequest): ManagedRuntimeHandle {
    if (this.lifetime.signal.aborted) {
      throw new ManagedRuntimeProviderError(
        'managed_runtime_disposed',
        'Managed Runtime provider is disposed.',
        false,
      );
    }
    let entry = this.entries.get(request.sessionId);
    if (entry && !sameManagedRuntimeIdentity(entry.request, request)) {
      throw new ManagedRuntimeProviderError(
        'managed_runtime_identity_conflict',
        'Managed Runtime Session identity changed.',
        false,
      );
    }
    if (entry) {
      entry.request = structuredClone(request);
    }
    if (!entry) {
      const controller = new AbortController();
      const signal = AbortSignal.any([this.lifetime.signal, controller.signal]);
      const ready = this.prepareRemote(request, signal);
      entry = { request: structuredClone(request), controller, ready };
      this.entries.set(request.sessionId, entry);
      void ready.catch(() => {
        if (this.entries.get(request.sessionId) === entry) {
          this.entries.delete(request.sessionId);
        }
      });
    }
    const active = entry;
    return {
      ready: active.ready,
      getManifest: async (signal) => {
        const operationSignal = AbortSignal.any([
          signal,
          active.controller.signal,
          this.lifetime.signal,
        ]);
        await waitForValue(active.ready, operationSignal);
        const response =
          await this.postIdempotentJson<ManagedRuntimeManifestResponse>(
            'manifest',
            active.request,
            operationSignal,
            MAX_REMOTE_MANIFEST_BYTES,
          );
        if (
          response.protocolVersion !== MANAGED_RUNTIME_PROTOCOL_VERSION ||
          !response.manifest
        ) {
          throw new Error(
            'Managed Runtime returned an invalid manifest response.',
          );
        }
        return response.manifest;
      },
      execute: async (toolRequest, signal) => {
        const operationSignal = AbortSignal.any([
          signal,
          active.controller.signal,
          this.lifetime.signal,
        ]);
        await waitForValue(active.ready, operationSignal);
        try {
          const response = await this.postJson<ManagedRuntimeExecuteResponse>(
            'execute',
            { ...active.request, toolRequest },
            operationSignal,
            MAX_REMOTE_TOOL_RESULT_BYTES,
          );
          if (
            response.protocolVersion !== MANAGED_RUNTIME_PROTOCOL_VERSION ||
            !response.result
          ) {
            throw new Error(
              'Managed Runtime returned an invalid Tool execution response.',
            );
          }
          return response.result;
        } catch (error) {
          if (signal.aborted) {
            void this.cancel(request.sessionId, toolRequest.executionId).catch(
              () => undefined,
            );
          }
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
    const entry = this.entries.get(sessionId);
    if (!entry || this.lifetime.signal.aborted) return false;
    if (expected && !sameManagedRuntimeIdentity(entry.request, expected)) {
      throw new ManagedRuntimeProviderError(
        'managed_runtime_identity_conflict',
        'Managed Runtime Session identity changed.',
        false,
      );
    }
    const response = await this.postJson<ManagedRuntimeCancelResponse>(
      'cancel',
      { ...entry.request, executionId },
      AbortSignal.timeout(CONTROL_REQUEST_TIMEOUT_MS),
      MAX_REMOTE_CONTROL_RESPONSE_BYTES,
    );
    if (response.protocolVersion !== MANAGED_RUNTIME_PROTOCOL_VERSION) {
      throw new Error('Managed Runtime returned an invalid cancel response.');
    }
    return response.cancelled === true;
  }

  async release(
    sessionId: string,
    expected?: ManagedRuntimePrepareRequest,
  ): Promise<boolean> {
    const entry = this.entries.get(sessionId);
    if (!entry) return false;
    if (expected && !sameManagedRuntimeIdentity(entry.request, expected)) {
      throw new ManagedRuntimeProviderError(
        'managed_runtime_identity_conflict',
        'Managed Runtime Session identity changed.',
        false,
      );
    }
    this.entries.delete(sessionId);
    entry.controller.abort(new Error('Managed Runtime Session released.'));
    if (this.lifetime.signal.aborted) return true;
    try {
      const response =
        await this.postIdempotentJson<ManagedRuntimeReleaseResponse>(
          'release',
          entry.request,
          AbortSignal.timeout(CONTROL_REQUEST_TIMEOUT_MS),
          MAX_REMOTE_CONTROL_RESPONSE_BYTES,
        );
      return (
        response.protocolVersion === MANAGED_RUNTIME_PROTOCOL_VERSION &&
        response.released === true
      );
    } catch {
      return false;
    }
  }

  dispose(): void {
    if (this.lifetime.signal.aborted) return;
    this.lifetime.abort(new Error('Managed Runtime provider disposed.'));
    for (const entry of this.entries.values()) {
      entry.controller.abort(new Error('Managed Runtime provider disposed.'));
    }
    this.entries.clear();
  }

  private async prepareRemote(
    request: ManagedRuntimePrepareRequest,
    signal: AbortSignal,
  ): Promise<void> {
    const startedAt = Date.now();
    let retryDelayMs = this.retryDelayMs;
    const deadline = new AbortController();
    const deadlineTimer = setTimeout(
      () =>
        deadline.abort(
          new ManagedRuntimeProviderError(
            'managed_runtime_unavailable',
            'Managed Runtime preparation timed out.',
            true,
          ),
        ),
      this.retryWindowMs,
    );
    deadlineTimer.unref();
    const prepareSignal = AbortSignal.any([signal, deadline.signal]);
    try {
      while (true) {
        prepareSignal.throwIfAborted();
        try {
          const response = await this.postJson<ManagedRuntimeReadyResponse>(
            'prepare',
            request,
            prepareSignal,
            MAX_REMOTE_CONTROL_RESPONSE_BYTES,
          );
          if (
            response.protocolVersion !== MANAGED_RUNTIME_PROTOCOL_VERSION ||
            response.ready !== true
          ) {
            throw new Error(
              'Managed Runtime returned an invalid ready response.',
            );
          }
          return;
        } catch (error) {
          if (prepareSignal.aborted) {
            throw abortError(prepareSignal, 'Runtime preparation aborted.');
          }
          const retryable =
            error instanceof TypeError ||
            (error instanceof RemoteResponseError &&
              (error.status === 429 || error.status === 503));
          if (!retryable || Date.now() - startedAt >= this.retryWindowMs) {
            throw error;
          }
          await delay(retryDelayMs, prepareSignal);
          retryDelayMs = Math.min(
            Math.max(retryDelayMs * 2, 1),
            this.retryMaxDelayMs,
          );
        }
      }
    } finally {
      clearTimeout(deadlineTimer);
    }
  }

  private async postJson<T>(
    operation: string,
    body: unknown,
    signal: AbortSignal,
    maxResponseBytes: number,
  ): Promise<T> {
    const response = await this.fetchImpl(
      new URL(
        `${MANAGED_RUNTIME_ROUTE_PREFIX.slice(1)}/${operation}`,
        this.baseUrl,
      ),
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal,
      },
    );
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new RemoteResponseError(response.status);
    }
    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > maxResponseBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error('Managed Runtime response exceeded its size limit.');
    }
    const text = await readBoundedResponseText(response, maxResponseBytes);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error('Managed Runtime returned invalid JSON.');
    }
  }

  private async postIdempotentJson<T>(
    operation: string,
    body: unknown,
    signal: AbortSignal,
    maxResponseBytes: number,
  ): Promise<T> {
    try {
      return await this.postJson<T>(operation, body, signal, maxResponseBytes);
    } catch (error) {
      const retryable =
        !signal.aborted &&
        (error instanceof TypeError ||
          (error instanceof RemoteResponseError && error.status === 503));
      if (!retryable) throw error;
      return this.postJson<T>(operation, body, signal, maxResponseBytes);
    }
  }
}

export type {
  BridgeManagedRuntimeToolExecuteRequest,
  BridgeManagedRuntimeToolExecuteResult,
  BridgeManagedRuntimeToolManifest,
};
