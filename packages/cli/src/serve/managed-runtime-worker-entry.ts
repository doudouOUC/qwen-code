/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import path from 'node:path';
import type { ManagedWorkerBoot } from './managed-runtime-activator.js';
import type { RunHandle } from './run-qwen-serve.js';

let handle: RunHandle | undefined;
let starting: Promise<void> | undefined;
let closing = false;
const bootTimer = setTimeout(() => {
  void close();
}, 30_000);
async function close(exitCode = 0): Promise<void> {
  if (closing) return;
  closing = true;
  clearTimeout(bootTimer);
  const force = setTimeout(() => process.exit(1), 15_000);
  try {
    await starting?.catch(() => {});
    await handle?.close();
  } catch {
    exitCode = 1;
  } finally {
    clearTimeout(force);
    process.exit(exitCode);
  }
}
process.once('disconnect', () => {
  void close();
});
process.once('SIGTERM', () => {
  void close();
});
process.once('SIGINT', () => {
  void close();
});
process.once('error', () => {
  void close();
});
process.on('message', (message: unknown) => {
  if ((message as { type?: unknown })?.type === 'shutdown') {
    void close();
    return;
  }
  if (starting || closing || !validBoot(message)) {
    void close(1);
    return;
  }
  clearTimeout(bootTimer);
  const boot = message;
  starting = (async () => {
    process.env['QWEN_RUNTIME_DIR'] = boot.outputRoot;
    process.env['QWEN_CLI_ENTRY'] = boot.cliEntry;
    const { runQwenServe } = await import('./run-qwen-serve.js');
    if (closing || !process.connected) return;
    handle = await runQwenServe(
      {
        mode: 'http-bridge',
        hostname: '127.0.0.1',
        port: 0,
        workspace: boot.workspaceCwd,
        token: boot.token,
        requireAuth: true,
        serveWebShell: false,
        experimentalManagedRuntimeWorker: true,
      },
      {
        ownedManagedRuntime: boot,
        preheatBridge: false,
        daemonLogBaseDir: path.join(boot.outputRoot, 'debug'),
      },
    );
    await handle.runtimeReady;
    if (closing || !process.connected) return;
    process.send?.(
      {
        type: 'ready',
        version: 1,
        gatewayIncarnation: boot.gatewayIncarnation,
        leaseId: boot.leaseId,
        epoch: boot.epoch,
        tenantId: boot.tenantId,
        workspaceId: boot.workspaceId,
        workspaceCwd: boot.workspaceCwd,
        url: handle.url,
      },
      (error) => {
        if (error) void close();
      },
    );
  })();
  void starting.catch(() => {
    void close(1);
  });
});
if (!process.connected) void close(1);

function validBoot(value: unknown): value is ManagedWorkerBoot {
  if (
    !value ||
    typeof value !== 'object' ||
    JSON.stringify(value).length > 32_768
  )
    return false;
  const boot = value as Record<string, unknown>;
  const strings = [
    'gatewayIncarnation',
    'leaseId',
    'tenantId',
    'workspaceId',
    'workspaceCwd',
    'token',
    'outputRoot',
    'cliEntry',
  ];
  return (
    Object.keys(boot).length === strings.length + 3 &&
    boot['type'] === 'boot' &&
    boot['version'] === 1 &&
    Number.isSafeInteger(boot['epoch']) &&
    (boot['epoch'] as number) > 0 &&
    strings.every(
      (k) => typeof boot[k] === 'string' && (boot[k] as string).length > 0,
    ) &&
    ['workspaceCwd', 'outputRoot', 'cliEntry'].every((k) =>
      path.isAbsolute(boot[k] as string),
    )
  );
}
