/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import { ApprovalMode } from '../config/approval-mode.js';
import type { ShellConfiguration } from '../utils/shell-utils.js';
import {
  getEditToolDefinition,
  getGlobToolDefinition,
  getGrepToolDefinition,
  getNotebookEditToolDefinition,
  getLSToolDefinition,
  getReadFileToolDefinition,
  getShellToolDefinition,
  getWriteFileToolDefinition,
  projectEditToolClassifierInput,
  projectReadFileToolClassifierInput,
  projectShellToolClassifierInput,
  projectWriteFileToolClassifierInput,
} from './builtin-tool-definitions.js';
import type { ManagedToolV2Client } from './managed-tool-runtime.js';
import { RuntimeBackedTool } from './runtime-backed-tool.js';
import { ToolNames } from './tool-names.js';
import {
  ToolConfirmationOutcome,
  type ToolCallConfirmationDetails,
} from './tools.js';

export interface ManagedToolSession {
  readonly sessionId: string;
  readonly shellConfiguration: ShellConfiguration;
  readonly platform: NodeJS.Platform;
  getClient(): Promise<ManagedToolV2Client>;
  createChild?(config: Config): ManagedToolSession;
  beginFileHistoryTurn?(promptId: string): Promise<void>;
  flushFileHistory?(): Promise<void>;
  close(): Promise<void>;
}

export type ManagedToolSessionFactory = (config: Config) => ManagedToolSession;

export interface ManagedChildExecutionScope {
  readonly config: Config;
  readonly signal?: AbortSignal;
  run<T>(operation: () => Promise<T>): Promise<T>;
  onClose(cleanup: () => void | Promise<void>): void;
  close(): Promise<void>;
}

export function createManagedChildExecutionScope(
  config: Config,
): ManagedChildExecutionScope {
  return config.createManagedChildExecutionScope();
}

export function createManagedBuiltinTool(
  name: string,
  config: Config,
  session: ManagedToolSession,
  getClient: () => Promise<ManagedToolV2Client>,
): RuntimeBackedTool | undefined {
  const shared = {
    sessionId: session.sessionId,
    getClient,
    onConfirm: (
      outcome: ToolConfirmationOutcome,
      details: ToolCallConfirmationDetails,
    ) => {
      if (
        details.type === 'edit' &&
        outcome === ToolConfirmationOutcome.ProceedAlways
      ) {
        config.setApprovalMode(ApprovalMode.AUTO_EDIT);
      }
    },
  };
  switch (name) {
    case ToolNames.NOTEBOOK_EDIT:
      return new RuntimeBackedTool({
        ...shared,
        descriptor: getNotebookEditToolDefinition(),
        projectClassifierInput: () => '',
      });
    case ToolNames.GREP:
      return new RuntimeBackedTool({
        ...shared,
        descriptor: getGrepToolDefinition(),
        projectClassifierInput: () => '',
      });
    case ToolNames.GLOB:
      return new RuntimeBackedTool({
        ...shared,
        descriptor: getGlobToolDefinition(),
        projectClassifierInput: () => '',
      });
    case ToolNames.LS:
      return new RuntimeBackedTool({
        ...shared,
        descriptor: getLSToolDefinition(),
        projectClassifierInput: () => '',
      });
    case ToolNames.READ_FILE:
      return new RuntimeBackedTool({
        ...shared,
        descriptor: getReadFileToolDefinition(),
        projectClassifierInput: projectReadFileToolClassifierInput,
      });
    case ToolNames.WRITE_FILE:
      return new RuntimeBackedTool({
        ...shared,
        descriptor: getWriteFileToolDefinition(),
        projectClassifierInput: projectWriteFileToolClassifierInput,
      });
    case ToolNames.EDIT:
      return new RuntimeBackedTool({
        ...shared,
        descriptor: getEditToolDefinition(),
        projectClassifierInput: projectEditToolClassifierInput,
      });
    case ToolNames.SHELL:
      return new RuntimeBackedTool({
        ...shared,
        descriptor: getShellToolDefinition({
          shellConfiguration: session.shellConfiguration,
          platform: session.platform,
          outputThreshold: config.isTruncateToolOutputThresholdExplicit()
            ? config.getTruncateToolOutputThreshold()
            : undefined,
        }),
        projectClassifierInput: (params) =>
          projectShellToolClassifierInput(params, config.getTargetDir()),
      });
    default:
      return undefined;
  }
}
