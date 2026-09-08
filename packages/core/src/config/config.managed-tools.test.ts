/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Config, deriveConfig } from './config.js';
import type { PermissionManager } from '../permissions/permission-manager.js';
import type { ManagedToolSession } from '../tools/managed-tool-session.js';
import { RuntimeBackedTool } from '../tools/runtime-backed-tool.js';
import { ToolNames } from '../tools/tool-names.js';

const localConstruct = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error('Gateway constructed a local tool');
  }),
);
vi.mock('../tools/read-file.js', () => ({ ReadFileTool: localConstruct }));
vi.mock('../tools/write-file.js', () => ({ WriteFileTool: localConstruct }));
vi.mock('../tools/edit.js', () => ({ EditTool: localConstruct }));
vi.mock('../tools/shell.js', () => ({ ShellTool: localConstruct }));

const names = [
  ToolNames.READ_FILE,
  ToolNames.WRITE_FILE,
  ToolNames.EDIT,
  ToolNames.SHELL,
];

describe('Config managed tool registration', () => {
  let root: string;
  let config: Config;
  const getClient = vi.fn<ManagedToolSession['getClient']>();
  const close = vi.fn<ManagedToolSession['close']>();
  const status = vi.fn<PermissionManager['getToolRegistrationStatus']>();

  beforeEach(async () => {
    root = await realpath(
      await mkdtemp(join(tmpdir(), 'managed-registry-config-')),
    );
    vi.stubEnv('QWEN_HOME', root);
    vi.stubEnv('QWEN_RUNTIME_DIR', join(root, 'output'));
    getClient.mockReset().mockRejectedValue(new Error('Runtime not ready'));
    close.mockReset().mockResolvedValue(undefined);
    localConstruct.mockClear();
    status
      .mockReset()
      .mockImplementation(async (name) =>
        names.includes(name as (typeof names)[number])
          ? 'registered'
          : 'disabled',
      );
    config = new Config({
      targetDir: root,
      cwd: root,
      debugMode: false,
      model: 'test',
      telemetry: { enabled: false },
      usageStatisticsEnabled: false,
      useRipgrep: false,
      managedToolSessionFactory: () => ({
        sessionId: randomUUID(),
        getClient,
        close,
        shellConfiguration: {
          shell: 'bash',
          executable: 'bash',
          argsPrefix: ['-c'],
        },
        platform: 'darwin',
      }),
    });
    vi.spyOn(config, 'getPermissionManager').mockReturnValue({
      getToolRegistrationStatus: status,
    } as unknown as PermissionManager);
  });
  afterEach(async () => {
    close.mockResolvedValue(undefined);
    await config.shutdown({
      shutdownTelemetry: false,
      strictResourceCleanup: true,
    });
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  it('warms actual lazy factories and exposes schemas without local constructors or Runtime readiness', async () => {
    const registry = await config.createToolRegistry(undefined, {
      skipDiscovery: true,
    });
    await registry.warmAll({ strict: true });
    expect(registry.getAllToolNames().sort()).toEqual([...names].sort());
    for (const name of names) {
      expect(registry.getTool(name)).toBeInstanceOf(RuntimeBackedTool);
      expect(
        registry
          .getFunctionDeclarations()
          .some((schema) => schema.name === name),
      ).toBe(true);
    }
    expect(localConstruct).not.toHaveBeenCalled();
    expect(getClient).not.toHaveBeenCalled();
    const invocation = registry
      .getTool(ToolNames.READ_FILE)!
      .build({ file_path: join(root, 'file') });
    await expect(
      invocation.managed!.prepare(new AbortController().signal, {
        callId: 'call',
        promptId: 'turn',
      }),
    ).rejects.toThrow('Runtime not ready');
    expect(getClient).toHaveBeenCalledOnce();
    await registry.stop();
  });

  it('preserves disabled and permission-deferred registration', async () => {
    status.mockImplementation(async (name) =>
      name === ToolNames.READ_FILE ? 'deferred' : 'disabled',
    );
    const registry = await config.createToolRegistry(undefined, {
      skipDiscovery: true,
    });
    await registry.warmAll({ strict: true });
    expect(registry.getAllToolNames()).toEqual([ToolNames.READ_FILE]);
    expect(registry.getTool(ToolNames.READ_FILE)).toBeInstanceOf(
      RuntimeBackedTool,
    );
    expect(registry.getFunctionDeclarations()).toEqual([]);
    expect(getClient).not.toHaveBeenCalled();
    await registry.stop();
  });

  it('awaits and retries remote cleanup even without completing Config initialization', async () => {
    const registry = await config.createToolRegistry(undefined, {
      skipDiscovery: true,
    });
    close.mockRejectedValueOnce(new Error('worker still running'));
    await expect(
      config.shutdown({
        strictResourceCleanup: true,
        shutdownTelemetry: false,
      }),
    ).rejects.toThrow('worker still running');
    await config.shutdown({
      strictResourceCleanup: true,
      shutdownTelemetry: false,
    });
    expect(close).toHaveBeenCalledTimes(2);
    await registry.stop();
  });

  it('keeps ordinary ACP close strict and retains the writer after a failed Runtime release', async () => {
    const registry = await config.createToolRegistry(undefined, {
      skipDiscovery: true,
    });
    const writer = vi.spyOn(config, 'closeSessionWriter');
    close.mockRejectedValueOnce(new Error('release uncertain'));
    await expect(config.shutdown({ shutdownTelemetry: false })).rejects.toThrow(
      'release uncertain',
    );
    expect(writer).not.toHaveBeenCalled();
    await config.shutdown({ shutdownTelemetry: false });
    expect(writer).toHaveBeenCalledOnce();
    await registry.stop();
  });

  it('does not let an unbound child execute through its parent Runtime Session', async () => {
    const child = deriveConfig(config);
    const registry = await child.createToolRegistry(undefined, {
      skipDiscovery: true,
      forSubAgent: true,
    });
    await registry.warmAll({ strict: true });
    const invocation = registry
      .getTool(ToolNames.READ_FILE)!
      .build({ file_path: join(root, 'file') });
    await expect(
      invocation.managed!.prepare(new AbortController().signal, {
        callId: 'child-call',
        promptId: 'child-turn',
      }),
    ).rejects.toThrow('scope is not bound');
    expect(getClient).not.toHaveBeenCalled();
    expect(localConstruct).not.toHaveBeenCalled();
    await registry.stop();
  });
});
