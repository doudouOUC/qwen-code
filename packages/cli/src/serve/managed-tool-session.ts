/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import type {
  ManagedToolSessionFactory,
  ManagedToolV2Client,
  ShellConfiguration,
} from '@qwen-code/qwen-code-core';
import type { ManagedRuntimeProvider } from './managed-runtime-provider.js';
import type { ManagedRuntimePrepareRequest } from './managed-runtime-protocol.js';
import type { WorkspaceGenerationGuard } from './workspace-registry.js';

export function createManagedToolSessionFactory(options: {
  provider: ManagedRuntimeProvider;
  tenantId: string;
  workspaceId: string;
  workspaceCwd: string;
  workspaceTrusted: boolean;
  generationGuard: WorkspaceGenerationGuard;
  shellConfiguration: ShellConfiguration;
  platform: NodeJS.Platform;
}): ManagedToolSessionFactory {
  const {
    provider,
    tenantId,
    workspaceId,
    workspaceCwd,
    workspaceTrusted,
    generationGuard,
    platform,
  } = options;
  const shellConfiguration = structuredClone(options.shellConfiguration);
  if (!provider.getToolV2Client) {
    throw new Error('Managed Agent requires a v2 tool Runtime provider.');
  }
  const acquire = provider.getToolV2Client.bind(provider);

  return (config) => {
    const request: ManagedRuntimePrepareRequest = Object.freeze({
      protocolVersion: 1,
      tenantId,
      workspaceId,
      workspaceCwd,
      sessionId: randomUUID(),
      turnKind: 'bootstrap',
    });
    let acquisition: Promise<ManagedToolV2Client> | undefined;
    let dispatched = false;
    let closing = false;
    let cleanup: Promise<void> | undefined;

    return {
      sessionId: request.sessionId,
      shellConfiguration: structuredClone(shellConfiguration),
      platform,
      getClient: () => {
        generationGuard.assertOpen();
        if (closing) throw new Error('Managed tool Session is closing.');
        if (!workspaceTrusted || config.getTargetDir() !== workspaceCwd) {
          throw new Error('Managed tool Session workspace binding changed.');
        }
        acquisition ??= (async () => {
          if ((await realpath(workspaceCwd)) !== workspaceCwd) {
            throw new Error('Managed tool Session workspace is not canonical.');
          }
          generationGuard.assertOpen();
          if (closing) throw new Error('Managed tool Session is closing.');
          dispatched = true;
          const client = await acquire(request);
          generationGuard.assertOpen();
          if (closing) throw new Error('Managed tool Session is closing.');
          return client;
        })();
        return acquisition;
      },
      close: () => {
        closing = true;
        cleanup ??= (async () => {
          try {
            await acquisition;
          } catch {
            // A failed acquire can still have allocated a remote Session.
          }
          if (
            dispatched &&
            !(await provider.release(request.sessionId, request, {
              terminal: true,
            }))
          ) {
            throw new Error(
              'Managed tool Runtime Session release is unproven.',
            );
          }
        })();
        const current = cleanup;
        void current.catch(() => {
          if (cleanup === current) cleanup = undefined;
        });
        return current;
      },
    };
  };
}
