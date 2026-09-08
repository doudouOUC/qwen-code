/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import { getShellConfiguration } from '../utils/shell-utils.js';
import {
  getEditToolDefinition,
  getReadFileToolDefinition,
  getShellToolDefinition,
  getWriteFileToolDefinition,
} from './builtin-tool-definitions.js';
import { ReadFileTool } from './read-file.js';
import { WriteFileTool } from './write-file.js';
import { EditTool } from './edit.js';
import { ShellTool } from './shell.js';
import { ManagedToolRuntime } from './managed-tool-runtime.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('builtin tool definition compatibility', () => {
  it.each([
    { platform: 'linux', comSpec: undefined, threshold: undefined },
    { platform: 'win32', comSpec: 'cmd.exe', threshold: 0 },
    {
      platform: 'win32',
      comSpec: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      threshold: 40_000,
    },
    {
      platform: 'win32',
      comSpec: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      threshold: undefined,
    },
  ] as const)(
    'matches the real Runtime manifest for $platform / $comSpec / $threshold',
    ({ platform, comSpec, threshold }) => {
      vi.spyOn(os, 'platform').mockReturnValue(platform);
      vi.stubEnv('ComSpec', comSpec);
      vi.stubEnv('MSYSTEM', undefined);
      vi.stubEnv('TERM', undefined);
      const config = {
        isTruncateToolOutputThresholdExplicit: () => threshold !== undefined,
        getTruncateToolOutputThreshold: () => threshold,
      } as unknown as Config;
      const tools = [
        new ReadFileTool(config),
        new WriteFileTool(config),
        new EditTool(config),
        new ShellTool(config),
      ];
      const runtime = new ManagedToolRuntime(
        config,
        () => tools,
        () => 'policy',
      );
      expect(runtime.manifest().tools).toEqual([
        getReadFileToolDefinition(),
        getWriteFileToolDefinition(),
        getEditToolDefinition(),
        getShellToolDefinition({
          shellConfiguration: getShellConfiguration(),
          platform,
          outputThreshold: threshold,
        }),
      ]);
    },
  );
});
