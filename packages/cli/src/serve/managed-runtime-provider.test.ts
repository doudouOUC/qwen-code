/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment node

import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AcpSessionBridge } from './acp-session-bridge.js';
import {
  LocalManagedRuntimeProvider,
  RemoteManagedRuntimeProvider,
} from './managed-runtime-provider.js';
import {
  MANAGED_RUNTIME_PROTOCOL_VERSION,
  MANAGED_RUNTIME_ROUTE_PREFIX,
  parseManagedRuntimeExecuteRequest,
  parseManagedRuntimePrepareRequest,
  type ManagedRuntimePrepareRequest,
} from './managed-runtime-protocol.js';
import { registerManagedRuntimeWorkerRoutes } from './routes/managed-runtime-worker.js';
import type {
  WorkspaceRegistry,
  WorkspaceRuntime,
} from './workspace-registry.js';

const workspaceCwd = '/tmp/managed-runtime-p8';
const workspaceId = 'workspace-p8';
const token = 'runtime-secret';

const prepareRequest: ManagedRuntimePrepareRequest = {
  protocolVersion: MANAGED_RUNTIME_PROTOCOL_VERSION,
  tenantId: 'tenant-p8',
  workspaceId,
  workspaceCwd,
  sessionId: '550e8400-e29b-41d4-a716-446655440108',
  turnKind: 'bootstrap',
};

const tools = [{ name: 'read_file', description: 'Read one file' }];
const manifest = {
  capabilityDigest: createHash('sha256')
    .update(JSON.stringify(tools))
    .digest('hex'),
  tools,
};

function fakeRuntime(): {
  bridge: AcpSessionBridge;
  registry: WorkspaceRegistry;
  execute: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
} {
  const execute = vi.fn(async (_sessionId, toolRequest) => ({
    responseParts: [
      {
        functionResponse: {
          id: toolRequest.toolCallId,
          name: toolRequest.toolName,
          response: { output: 'remote workspace evidence' },
        },
      },
    ],
    executionStatus: 'success' as const,
  }));
  const cancel = vi.fn(async () => ({ cancelled: true }));
  const close = vi.fn(async () => undefined);
  const bridge = {
    spawnOrAttach: vi.fn(async (input) => ({
      sessionId: input.sessionId!,
      workspaceCwd,
      attached: false,
      clientId: 'runtime-client-p8',
      hasActivePrompt: false,
      sourceType: 'managed-gateway',
      sourceId: input.sessionId!,
    })),
    resumeSession: vi.fn(),
    getSessionSummary: vi.fn(() => {
      throw Object.assign(new Error('not live'), { code: 'session_not_found' });
    }),
    recordHeartbeat: vi.fn(),
    getManagedRuntimeToolManifest: vi.fn(async () => manifest),
    executeManagedRuntimeTool: execute,
    cancelManagedRuntimeTool: cancel,
    closeSession: close,
    detachClient: vi.fn(async () => undefined),
  } as unknown as AcpSessionBridge;
  const runtime = {
    workspaceId,
    workspaceCwd,
    trusted: true,
    bridge,
  } as WorkspaceRuntime;
  const registry = {
    getByWorkspaceId: vi.fn((id: string) =>
      id === workspaceId ? runtime : undefined,
    ),
  } as unknown as WorkspaceRegistry;
  return { bridge, registry, execute, cancel, close };
}

function workerApp(provider: LocalManagedRuntimeProvider) {
  const app = express();
  app.use(express.json());
  registerManagedRuntimeWorkerRoutes(app, {
    provider,
    authorize: (req, res, next) => {
      if (req.headers.authorization !== `Bearer ${token}`) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      next();
    },
  });
  return app;
}

async function listen(server: Server, port = 0): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  return (server.address() as AddressInfo).port;
}

async function close(server: Server | undefined): Promise<void> {
  if (!server?.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

describe('Managed Runtime providers', () => {
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => close(server)));
  });

  it('keeps Gateway prepare pending until a separate Runtime worker starts', async () => {
    const reservation = createServer();
    const port = await listen(reservation);
    await close(reservation);

    const runtime = fakeRuntime();
    const local = new LocalManagedRuntimeProvider(runtime.registry);
    const remote = new RemoteManagedRuntimeProvider({
      baseUrl: `http://127.0.0.1:${port}`,
      token,
      prepareRetryDelayMs: 5,
      prepareRetryMaxDelayMs: 10,
      prepareRetryWindowMs: 2_000,
    });
    const handle = remote.prepare(prepareRequest);
    let ready = false;
    void handle.ready.then(() => {
      ready = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(ready).toBe(false);
    expect(runtime.bridge.spawnOrAttach).not.toHaveBeenCalled();

    const server = createServer(workerApp(local));
    servers.push(server);
    await listen(server, port);
    await handle.ready;
    expect(runtime.bridge.spawnOrAttach).toHaveBeenCalledTimes(1);

    await expect(
      handle.getManifest(new AbortController().signal),
    ).resolves.toEqual(manifest);
    await expect(
      handle.execute(
        {
          executionId: 'execution-p8',
          turnId: 'turn-p8',
          toolCallId: 'call-p8',
          capabilityDigest: manifest.capabilityDigest,
          toolName: 'read_file',
          input: { file_path: 'proof.txt' },
        },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ executionStatus: 'success' });
    expect(runtime.execute).toHaveBeenCalledTimes(1);

    await close(server);
    local.dispose();
    vi.mocked(runtime.bridge.resumeSession).mockResolvedValueOnce({
      sessionId: prepareRequest.sessionId,
      workspaceCwd,
      attached: true,
      clientId: 'runtime-client-restored-p8',
      hasActivePrompt: false,
      sourceType: 'managed-gateway',
      sourceId: prepareRequest.sessionId,
      sourcePersisted: true,
      state: {} as never,
    });
    const restoredLocal = new LocalManagedRuntimeProvider(runtime.registry);
    const restoredServer = createServer(workerApp(restoredLocal));
    servers.push(restoredServer);
    await listen(restoredServer, port);
    const continuation = remote.prepare({
      ...prepareRequest,
      turnKind: 'continuation',
    });
    await continuation.ready;
    await expect(
      continuation.getManifest(new AbortController().signal),
    ).resolves.toEqual(manifest);
    expect(runtime.bridge.resumeSession).toHaveBeenCalledWith({
      sessionId: prepareRequest.sessionId,
      workspaceCwd,
      sourceType: 'managed-gateway',
      sourceId: prepareRequest.sessionId,
    });

    await close(restoredServer);
    restoredLocal.dispose();
    vi.mocked(runtime.bridge.resumeSession).mockResolvedValueOnce({
      sessionId: prepareRequest.sessionId,
      workspaceCwd,
      attached: true,
      clientId: 'runtime-client-release-p8',
      hasActivePrompt: false,
      sourceType: 'managed-gateway',
      sourceId: prepareRequest.sessionId,
      sourcePersisted: true,
      state: {} as never,
    });
    const releaseLocal = new LocalManagedRuntimeProvider(runtime.registry);
    const releaseServer = createServer(workerApp(releaseLocal));
    servers.push(releaseServer);
    await listen(releaseServer, port);

    await expect(remote.release(prepareRequest.sessionId)).resolves.toBe(true);
    expect(runtime.close).toHaveBeenCalledWith(prepareRequest.sessionId, {
      clientId: 'runtime-client-release-p8',
    });
    remote.dispose();
    releaseLocal.dispose();
  });

  it('sends explicit cancellation without retrying Tool execution', async () => {
    const runtime = fakeRuntime();
    let executionStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      executionStarted = resolve;
    });
    runtime.execute.mockImplementation(
      (_sessionId, _toolRequest, signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          executionStarted();
          signal.addEventListener(
            'abort',
            () => reject(signal.reason ?? new Error('aborted')),
            { once: true },
          );
        }),
    );
    const local = new LocalManagedRuntimeProvider(runtime.registry);
    const server = createServer(workerApp(local));
    servers.push(server);
    const port = await listen(server);
    const remote = new RemoteManagedRuntimeProvider({
      baseUrl: `http://127.0.0.1:${port}`,
      token,
    });
    const handle = remote.prepare(prepareRequest);
    await handle.ready;
    const controller = new AbortController();
    const execution = handle.execute(
      {
        executionId: 'execution-cancel-p8',
        turnId: 'turn-cancel-p8',
        toolCallId: 'call-cancel-p8',
        capabilityDigest: manifest.capabilityDigest,
        toolName: 'read_file',
        input: { file_path: 'proof.txt' },
      },
      controller.signal,
    );
    await started;
    controller.abort(new Error('deadline'));
    await expect(execution).rejects.toThrow('deadline');
    await vi.waitFor(() => expect(runtime.cancel).toHaveBeenCalledTimes(1));
    expect(runtime.execute).toHaveBeenCalledTimes(1);
    remote.dispose();
    local.dispose();
  });

  it('closes a restored Session when release races with warmup', async () => {
    const runtime = fakeRuntime();
    let finishResume!: (session: {
      sessionId: string;
      workspaceCwd: string;
      attached: true;
      clientId: string;
      hasActivePrompt: false;
      sourceType: 'managed-gateway';
      sourceId: string;
      sourcePersisted: true;
      state: never;
    }) => void;
    vi.mocked(runtime.bridge.resumeSession).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishResume = resolve;
        }),
    );
    const local = new LocalManagedRuntimeProvider(runtime.registry);
    const continuation = {
      ...prepareRequest,
      turnKind: 'continuation',
    } as const;
    const handle = local.prepare(continuation);
    const ready = handle.ready.catch((error: unknown) => error);
    const release = local.release(prepareRequest.sessionId, continuation);

    finishResume({
      sessionId: prepareRequest.sessionId,
      workspaceCwd,
      attached: true,
      clientId: 'runtime-client-racing-release-p8',
      hasActivePrompt: false,
      sourceType: 'managed-gateway',
      sourceId: prepareRequest.sessionId,
      sourcePersisted: true,
      state: {} as never,
    });

    await expect(ready).resolves.toMatchObject({
      message: 'Managed Runtime Session released.',
    });
    await expect(release).resolves.toBe(true);
    expect(runtime.close).toHaveBeenCalledWith(prepareRequest.sessionId, {
      clientId: 'runtime-client-racing-release-p8',
    });
    local.dispose();
  });

  it('does not close a colliding Session when release races with warmup', async () => {
    const runtime = fakeRuntime();
    let finishResume!: (session: {
      sessionId: string;
      workspaceCwd: string;
      attached: true;
      clientId: string;
      hasActivePrompt: false;
      sourceType: 'foreign-owner';
      sourceId: string;
      sourcePersisted: true;
      state: never;
    }) => void;
    vi.mocked(runtime.bridge.resumeSession).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishResume = resolve;
        }),
    );
    const local = new LocalManagedRuntimeProvider(runtime.registry);
    const continuation = {
      ...prepareRequest,
      turnKind: 'continuation',
    } as const;
    const handle = local.prepare(continuation);
    const ready = handle.ready.catch((error: unknown) => error);
    const release = local.release(prepareRequest.sessionId, continuation);

    finishResume({
      sessionId: prepareRequest.sessionId,
      workspaceCwd,
      attached: true,
      clientId: 'foreign-client-p8',
      hasActivePrompt: false,
      sourceType: 'foreign-owner',
      sourceId: 'foreign-session-p8',
      sourcePersisted: true,
      state: {} as never,
    });

    await expect(ready).resolves.toMatchObject({
      message: 'Managed Runtime Session released.',
    });
    await expect(release).resolves.toBe(true);
    expect(runtime.close).not.toHaveBeenCalled();
    expect(runtime.bridge.detachClient).toHaveBeenCalledWith(
      prepareRequest.sessionId,
      'foreign-client-p8',
    );
    local.dispose();
  });

  it('rejects unauthenticated and model-bearing worker requests', async () => {
    const runtime = fakeRuntime();
    const local = new LocalManagedRuntimeProvider(runtime.registry);
    const app = workerApp(local);
    await request(app)
      .post(`${MANAGED_RUNTIME_ROUTE_PREFIX}/prepare`)
      .send(prepareRequest)
      .expect(401);
    const forbidden = await request(app)
      .post(`${MANAGED_RUNTIME_ROUTE_PREFIX}/prepare`)
      .set('authorization', `Bearer ${token}`)
      .send({ ...prepareRequest, prompt: 'must not cross the boundary' });
    expect(forbidden.status).toBe(400);
    expect(runtime.bridge.spawnOrAttach).not.toHaveBeenCalled();
    local.dispose();
  });

  it('treats a workspace mapping mismatch as a permanent conflict', async () => {
    const runtime = fakeRuntime();
    const local = new LocalManagedRuntimeProvider(runtime.registry);
    const response = await request(workerApp(local))
      .post(`${MANAGED_RUNTIME_ROUTE_PREFIX}/prepare`)
      .set('authorization', `Bearer ${token}`)
      .send({ ...prepareRequest, workspaceCwd: '/tmp/wrong-workspace' });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      code: 'managed_runtime_identity_conflict',
    });
    expect(runtime.bridge.spawnOrAttach).not.toHaveBeenCalled();
    local.dispose();
  });

  it('rejects cleartext non-loopback Runtime origins', () => {
    expect(
      () =>
        new RemoteManagedRuntimeProvider({
          baseUrl: 'http://10.0.0.10:4181',
          token,
        }),
    ).toThrow('must use HTTPS');
  });

  it('stops reading an oversized Runtime response', async () => {
    let requestCount = 0;
    const fetchImpl = vi.fn(async () => {
      requestCount += 1;
      if (requestCount === 1) {
        return Response.json({
          protocolVersion: MANAGED_RUNTIME_PROTOCOL_VERSION,
          ready: true,
        });
      }
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(600 * 1024));
            controller.enqueue(new Uint8Array(600 * 1024));
            controller.close();
          },
        }),
      );
    }) as unknown as typeof fetch;
    const remote = new RemoteManagedRuntimeProvider({
      baseUrl: 'http://127.0.0.1:4181',
      token,
      fetch: fetchImpl,
    });
    const handle = remote.prepare(prepareRequest);
    await handle.ready;

    await expect(
      handle.getManifest(new AbortController().signal),
    ).rejects.toThrow('exceeded its size limit');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    remote.dispose();
  });

  it('bounds a prepare request when the Runtime never responds', async () => {
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) return;
          const rejectAborted = () => reject(signal.reason);
          if (signal.aborted) rejectAborted();
          else signal.addEventListener('abort', rejectAborted, { once: true });
        }),
    ) as unknown as typeof fetch;
    const remote = new RemoteManagedRuntimeProvider({
      baseUrl: 'http://127.0.0.1:4181',
      token,
      fetch: fetchImpl,
      prepareRetryWindowMs: 20,
    });

    await expect(remote.prepare(prepareRequest).ready).rejects.toThrow(
      'preparation timed out',
    );
    remote.prepare(prepareRequest);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    remote.dispose();
  });

  it('invalidates an existing remote handle when its Session is released', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname.endsWith('/prepare')) {
        return Response.json({
          protocolVersion: MANAGED_RUNTIME_PROTOCOL_VERSION,
          ready: true,
        });
      }
      if (pathname.endsWith('/release')) {
        return Response.json({
          protocolVersion: MANAGED_RUNTIME_PROTOCOL_VERSION,
          released: true,
        });
      }
      return Response.json({
        protocolVersion: MANAGED_RUNTIME_PROTOCOL_VERSION,
        manifest,
      });
    }) as unknown as typeof fetch;
    const remote = new RemoteManagedRuntimeProvider({
      baseUrl: 'http://127.0.0.1:4181',
      token,
      fetch: fetchImpl,
    });
    const handle = remote.prepare(prepareRequest);
    await handle.ready;
    await expect(remote.release(prepareRequest.sessionId)).resolves.toBe(true);

    await expect(
      handle.getManifest(new AbortController().signal),
    ).rejects.toThrow('Managed Runtime Session released.');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    remote.dispose();
  });

  it('invalidates an existing local handle when its Session is released', async () => {
    const runtime = fakeRuntime();
    const local = new LocalManagedRuntimeProvider(runtime.registry);
    const handle = local.prepare(prepareRequest);
    await handle.ready;
    await expect(local.release(prepareRequest.sessionId)).resolves.toBe(true);

    await expect(
      handle.getManifest(new AbortController().signal),
    ).rejects.toThrow('Managed Runtime Session released.');
    expect(runtime.bridge.getManagedRuntimeToolManifest).not.toHaveBeenCalled();
    local.dispose();
  });
});

describe('Managed Runtime protocol', () => {
  it('accepts only versioned Prompt-free identity payloads', () => {
    expect(parseManagedRuntimePrepareRequest(prepareRequest)).toEqual(
      prepareRequest,
    );
    expect(() =>
      parseManagedRuntimePrepareRequest({
        ...prepareRequest,
        protocolVersion: 2,
      }),
    ).toThrow('unsupported');
    expect(() =>
      parseManagedRuntimePrepareRequest({
        ...prepareRequest,
        history: [],
      }),
    ).toThrow();
    expect(() =>
      parseManagedRuntimeExecuteRequest({
        ...prepareRequest,
        toolRequest: {
          executionId: 'x'.repeat(129),
          turnId: 'turn-p8',
          toolCallId: 'call-p8',
          capabilityDigest: manifest.capabilityDigest,
          toolName: 'read_file',
          input: {},
        },
      }),
    ).toThrow();
  });
});
