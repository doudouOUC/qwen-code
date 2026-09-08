/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createBuiltinManagedToolRuntime,
  ManagedToolProtocolError,
  ToolConfirmationOutcome,
  ToolNames,
  managedToolDigest,
  parseManagedToolCallIdentity,
  parseManagedToolInvocationReference,
  parseManagedToolConfirmationPayload,
  type ManagedToolRuntime,
} from '@qwen-code/qwen-code-core';
import { SERVE_CONTROL_EXT_METHODS } from '@qwen-code/acp-bridge/status';
import type { ManagedToolV2Client } from '@qwen-code/acp-bridge/bridgeTypes';
import { parseCallerSuppliedSessionId } from '../config/session-id.js';

const METHODS = SERVE_CONTROL_EXT_METHODS;
const methodKeys = new Map<string, readonly string[]>([
  [METHODS.sessionManagedToolV2Manifest, ['sessionId']],
  [METHODS.sessionManagedToolV2BeginTurn, ['sessionId', 'identity']],
  [
    METHODS.sessionManagedToolV2Prepare,
    ['sessionId', 'identity', 'toolName', 'input'],
  ],
  [METHODS.sessionManagedToolV2Confirmation, ['sessionId', 'reference']],
  [
    METHODS.sessionManagedToolV2Confirm,
    ['sessionId', 'reference', 'outcome', 'payload', 'phase'],
  ],
  [METHODS.sessionManagedToolV2Preflight, ['sessionId', 'reference']],
  [METHODS.sessionManagedToolV2Execute, ['sessionId', 'reference']],
  [METHODS.sessionManagedToolV2Status, ['sessionId', 'reference', 'afterSeq']],
  [METHODS.sessionManagedToolV2Cancel, ['sessionId', 'reference']],
]);

export function isManagedToolRuntimeMethod(method: string): boolean {
  return methodKeys.has(method);
}

export function isManagedToolRuntimeDrainMethod(method: string): boolean {
  return (
    method === METHODS.sessionManagedToolV2Status ||
    method === METHODS.sessionManagedToolV2Cancel
  );
}

export function parseManagedToolRuntimeSessionId(
  method: string,
  params: Record<string, unknown>,
): string {
  managedToolDigest(params, 1024 * 1024);
  const keys = methodKeys.get(method);
  if (!keys || Object.keys(params).some((key) => !keys.includes(key))) {
    throw new ManagedToolProtocolError();
  }
  const session = parseCallerSuppliedSessionId(params['sessionId']);
  if (session.kind !== 'valid' || session.sessionId !== params['sessionId'])
    throw new ManagedToolProtocolError();
  return session.sessionId;
}

export const createManagedToolRuntimeSession = createBuiltinManagedToolRuntime;

export async function dispatchManagedToolRuntimeRequest(
  runtime: ManagedToolRuntime | ManagedToolV2Client,
  method: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const sessionId = parseManagedToolRuntimeSessionId(method, params);
  if (method === METHODS.sessionManagedToolV2Manifest)
    return { ...(await runtime.manifest()) };
  if (
    method === METHODS.sessionManagedToolV2BeginTurn ||
    method === METHODS.sessionManagedToolV2Prepare
  ) {
    const identity = parseManagedToolCallIdentity(params['identity']);
    if (identity.sessionId !== sessionId) throw new ManagedToolProtocolError();
    if (method === METHODS.sessionManagedToolV2BeginTurn) {
      await runtime.beginTurn(identity);
      return { started: true };
    }
    const name = params['toolName'];
    const input = params['input'];
    if (
      typeof name !== 'string' ||
      name.length === 0 ||
      name.length > 256 ||
      name.includes('\0') ||
      input === null ||
      typeof input !== 'object' ||
      Array.isArray(input)
    )
      throw new ManagedToolProtocolError();
    managedToolDigest(input);
    const args = input as Record<string, unknown>;
    if (
      name === ToolNames.SHELL &&
      args['is_background'] !== undefined &&
      args['is_background'] !== false
    ) {
      throw new ManagedToolProtocolError(
        'Managed Tool Runtime currently requires foreground Shell execution.',
      );
    }
    return { ...(await runtime.prepare(identity, name, args)) };
  }
  const reference = parseManagedToolInvocationReference(params['reference']);
  if (reference.sessionId !== sessionId) throw new ManagedToolProtocolError();
  switch (method) {
    case METHODS.sessionManagedToolV2Confirmation:
      return { ...(await runtime.confirmation(reference)) };
    case METHODS.sessionManagedToolV2Confirm: {
      const outcome = params['outcome'];
      if (
        !Object.values(ToolConfirmationOutcome).some(
          (value) => value === outcome,
        )
      )
        throw new ManagedToolProtocolError();
      const phase =
        params['phase'] === undefined ? 'permission' : params['phase'];
      if (phase !== 'permission' && phase !== 'preflight')
        throw new ManagedToolProtocolError();
      await runtime.confirm(
        reference,
        outcome as ToolConfirmationOutcome,
        parseManagedToolConfirmationPayload(params['payload']),
        phase,
      );
      return { confirmed: true };
    }
    case METHODS.sessionManagedToolV2Preflight:
      return { ...(await runtime.preflight(reference)) };
    case METHODS.sessionManagedToolV2Execute:
      return { ...(await runtime.execute(reference)) };
    case METHODS.sessionManagedToolV2Status: {
      const afterSeq =
        params['afterSeq'] === undefined ? 0 : params['afterSeq'];
      if (
        typeof afterSeq !== 'number' ||
        !Number.isSafeInteger(afterSeq) ||
        afterSeq < 0
      )
        throw new ManagedToolProtocolError();
      return { ...(await runtime.status(reference, afterSeq)) };
    }
    case METHODS.sessionManagedToolV2Cancel:
      return { ...(await runtime.cancel(reference)) };
    default:
      throw new ManagedToolProtocolError();
  }
}
