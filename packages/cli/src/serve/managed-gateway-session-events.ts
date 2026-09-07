/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { isDeepStrictEqual } from 'node:util';
import type { ManagedGatewayPromptRequest } from './managed-prompt-types.js';

export type ManagedGatewaySessionEventType =
  | 'accepted'
  | 'runtime_starting'
  | 'runtime_ready'
  | 'runtime_failed'
  | 'agent_started'
  | 'assistant_thought'
  | 'assistant_delta'
  | 'tool_requested'
  | 'tool_completed'
  | 'completed'
  | 'failed'
  | 'stream_gap';

export interface ManagedGatewaySessionEvent {
  readonly id: number;
  readonly at: number;
  readonly type: ManagedGatewaySessionEventType;
  readonly data?: unknown;
}

export interface ManagedGatewaySessionStatus {
  readonly sessionId: string;
  readonly promptId: string;
  readonly phase:
    | 'admitted'
    | 'runtime_starting'
    | 'agent_running'
    | 'completed'
    | 'failed';
  readonly runtimeReady: boolean;
  readonly admittedAt: number;
  readonly updatedAt: number;
  readonly failure?: { readonly code: string; readonly message: string };
}

interface SessionState {
  request: ManagedGatewayPromptRequest;
  phase: ManagedGatewaySessionStatus['phase'];
  runtimeReady: boolean;
  admittedAt: number;
  updatedAt: number;
  failure?: { code: string; message: string };
  events: ManagedGatewaySessionEvent[];
  eventBytes: number;
  nextEventId: number;
  waiters: Set<() => void>;
}

const MAX_EVENTS_PER_SESSION = 2048;
const MAX_EVENT_BYTES = 768 * 1024;
const MAX_EVENT_BYTES_PER_SESSION = 1024 * 1024;
const MAX_RETAINED_SESSIONS = 64;

function semanticRequest(request: ManagedGatewayPromptRequest): unknown {
  return {
    tenantId: request.tenantId,
    workspaceId: request.workspaceId,
    workspaceCwd: request.workspaceCwd,
    sessionId: request.sessionId,
    messageId: request.messageId,
    managedClientId: request.managedClientId,
    turnKind: request.turnKind,
    prompt: request.prompt,
  };
}

function sessionIdentity(request: ManagedGatewayPromptRequest): unknown {
  return {
    tenantId: request.tenantId,
    workspaceId: request.workspaceId,
    workspaceCwd: request.workspaceCwd,
    sessionId: request.sessionId,
    managedClientId: request.managedClientId,
  };
}

export class ManagedGatewaySessionEvents {
  private readonly sessions = new Map<string, SessionState>();
  private disposed = false;

  ensure(request: ManagedGatewayPromptRequest): ManagedGatewaySessionStatus {
    if (this.disposed) {
      throw new Error('Managed Gateway Session events are disposed.');
    }
    const existing = this.sessions.get(request.sessionId);
    if (existing) {
      if (
        !isDeepStrictEqual(
          sessionIdentity(existing.request),
          sessionIdentity(request),
        )
      ) {
        throw new Error(
          `Managed Gateway Session '${request.sessionId}' was reused with a different identity.`,
        );
      }
      if (
        isDeepStrictEqual(
          semanticRequest(existing.request),
          semanticRequest(request),
        )
      ) {
        return this.snapshot(existing);
      }
      if (existing.phase !== 'completed' && existing.phase !== 'failed') {
        throw new Error(
          `Managed Gateway Session '${request.sessionId}' already has an active turn.`,
        );
      }
      const now = Date.now();
      existing.request = structuredClone(request);
      existing.phase = 'admitted';
      existing.runtimeReady = false;
      existing.admittedAt = now;
      existing.updatedAt = now;
      delete existing.failure;
      this.append(existing, 'accepted', {
        sessionId: request.sessionId,
        promptId: request.messageId,
      });
      return this.snapshot(existing);
    }
    this.prune();
    const now = Date.now();
    const state: SessionState = {
      request: structuredClone(request),
      phase: 'admitted',
      runtimeReady: false,
      admittedAt: now,
      updatedAt: now,
      events: [],
      eventBytes: 0,
      nextEventId: 1,
      waiters: new Set(),
    };
    this.sessions.set(request.sessionId, state);
    this.append(state, 'accepted', {
      sessionId: request.sessionId,
      promptId: request.messageId,
    });
    return this.snapshot(state);
  }

  authorize(
    sessionId: string,
    managedClientId: string,
  ): ManagedGatewaySessionStatus | undefined {
    const state = this.sessions.get(sessionId);
    if (!state || state.request.managedClientId !== managedClientId) {
      return undefined;
    }
    return this.snapshot(state);
  }

  markRuntimeStarting(request: ManagedGatewayPromptRequest): void {
    const state = this.required(request);
    if (state.phase !== 'completed' && state.phase !== 'failed') {
      state.phase = 'runtime_starting';
    }
    this.append(state, 'runtime_starting');
  }

  markRuntimeReady(request: ManagedGatewayPromptRequest): void {
    const state = this.bound(request);
    state.runtimeReady = true;
    this.append(state, 'runtime_ready');
  }

  markRuntimeFailed(request: ManagedGatewayPromptRequest): void {
    const state = this.bound(request);
    state.runtimeReady = false;
    this.append(state, 'runtime_failed', {
      message: 'Runtime warmup failed; a later turn may retry.',
    });
  }

  markAgentStarted(
    request: ManagedGatewayPromptRequest,
    round: number,
    agentDefinitionId: string,
  ): void {
    const state = this.required(request);
    if (state.phase !== 'completed' && state.phase !== 'failed') {
      state.phase = 'agent_running';
    }
    this.append(state, 'agent_started', { round, agentDefinitionId });
  }

  appendAssistantThought(
    request: ManagedGatewayPromptRequest,
    text: string,
  ): void {
    if (!text) return;
    this.append(this.required(request), 'assistant_thought', { text });
  }

  appendAssistantDelta(
    request: ManagedGatewayPromptRequest,
    text: string,
  ): void {
    if (!text) return;
    this.append(this.required(request), 'assistant_delta', { text });
  }

  markToolRequested(
    request: ManagedGatewayPromptRequest,
    toolCallId: string,
    toolName: string,
  ): void {
    this.append(this.required(request), 'tool_requested', {
      toolCallId,
      toolName,
    });
  }

  markToolCompleted(
    request: ManagedGatewayPromptRequest,
    toolCallId: string,
    toolName: string,
    failed: boolean,
  ): void {
    this.append(this.required(request), 'tool_completed', {
      toolCallId,
      toolName,
      failed,
    });
  }

  complete(request: ManagedGatewayPromptRequest): void {
    const state = this.required(request);
    state.phase = 'completed';
    this.append(state, 'completed', {
      sessionId: request.sessionId,
      promptId: request.messageId,
    });
  }

  fail(
    request: ManagedGatewayPromptRequest,
    failure: { readonly code: string; readonly message: string },
  ): void {
    const state = this.required(request);
    if (state.phase === 'completed' || state.phase === 'failed') return;
    state.phase = 'failed';
    state.failure = { ...failure };
    this.append(state, 'failed', {
      ...failure,
      sessionId: request.sessionId,
      promptId: request.messageId,
    });
  }

  async *subscribe(
    sessionId: string,
    managedClientId: string,
    afterEventId: number | undefined,
    signal: AbortSignal,
  ): AsyncIterable<ManagedGatewaySessionEvent> {
    const state = this.sessions.get(sessionId);
    if (!state || state.request.managedClientId !== managedClientId) return;
    let cursor = afterEventId;
    while (!signal.aborted && !this.disposed) {
      const oldest = state.events[0]?.id;
      if (cursor !== undefined && oldest !== undefined && cursor < oldest - 1) {
        yield {
          id: oldest - 1,
          at: Date.now(),
          type: 'stream_gap',
          data: { oldestAvailableEventId: oldest },
        };
        return;
      }
      const events =
        cursor === undefined
          ? [...state.events]
          : state.events.filter((event) => event.id > cursor!);
      for (const event of events) {
        cursor = event.id;
        yield structuredClone(event);
        if (event.type === 'stream_gap') return;
      }
      const terminal = state.phase === 'completed' || state.phase === 'failed';
      const newestEventId = state.events.at(-1)?.id;
      if (
        terminal &&
        (newestEventId === undefined ||
          (cursor !== undefined && cursor >= newestEventId))
      ) {
        return;
      }
      if (events.length > 0) continue;
      await this.waitForChange(state, signal);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const state of this.sessions.values()) {
      this.wake(state);
    }
    this.sessions.clear();
  }

  private required(request: ManagedGatewayPromptRequest): SessionState {
    this.ensure(request);
    return this.sessions.get(request.sessionId)!;
  }

  private bound(request: ManagedGatewayPromptRequest): SessionState {
    const state = this.sessions.get(request.sessionId);
    if (
      !state ||
      !isDeepStrictEqual(
        sessionIdentity(state.request),
        sessionIdentity(request),
      )
    ) {
      throw new Error(
        `Managed Gateway Session '${request.sessionId}' has no matching event binding.`,
      );
    }
    return state;
  }

  private append(
    state: SessionState,
    type: ManagedGatewaySessionEventType,
    data?: unknown,
  ): void {
    let event: ManagedGatewaySessionEvent = {
      id: state.nextEventId++,
      at: Date.now(),
      type,
      ...(data === undefined ? {} : { data: structuredClone(data) }),
    };
    let bytes = Buffer.byteLength(JSON.stringify(event), 'utf8');
    if (bytes > MAX_EVENT_BYTES) {
      event = {
        id: event.id,
        at: event.at,
        type: 'stream_gap',
        data: { reason: 'event_too_large' },
      };
      bytes = Buffer.byteLength(JSON.stringify(event), 'utf8');
    }
    state.events.push(event);
    state.eventBytes += bytes;
    while (
      state.events.length > MAX_EVENTS_PER_SESSION ||
      state.eventBytes > MAX_EVENT_BYTES_PER_SESSION
    ) {
      const removed = state.events.shift();
      if (!removed) break;
      state.eventBytes -= Buffer.byteLength(JSON.stringify(removed), 'utf8');
    }
    state.updatedAt = event.at;
    this.wake(state);
  }

  private waitForChange(
    state: SessionState,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const wake = () => {
        signal.removeEventListener('abort', wake);
        state.waiters.delete(wake);
        resolve();
      };
      state.waiters.add(wake);
      signal.addEventListener('abort', wake, { once: true });
    });
  }

  private wake(state: SessionState): void {
    for (const waiter of state.waiters) waiter();
    state.waiters.clear();
  }

  private snapshot(state: SessionState): ManagedGatewaySessionStatus {
    return structuredClone({
      sessionId: state.request.sessionId,
      promptId: state.request.messageId,
      phase: state.phase,
      runtimeReady: state.runtimeReady,
      admittedAt: state.admittedAt,
      updatedAt: state.updatedAt,
      ...(state.failure === undefined ? {} : { failure: state.failure }),
    });
  }

  private prune(): void {
    if (this.sessions.size < MAX_RETAINED_SESSIONS) return;
    const terminal = [...this.sessions.entries()]
      .filter(
        ([, state]) => state.phase === 'completed' || state.phase === 'failed',
      )
      .sort((left, right) => left[1].updatedAt - right[1].updatedAt)[0];
    if (terminal) this.sessions.delete(terminal[0]);
  }
}
