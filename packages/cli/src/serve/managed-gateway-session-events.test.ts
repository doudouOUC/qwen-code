/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { ManagedGatewayPromptRequest } from './managed-prompt-types.js';
import { ManagedGatewaySessionEvents } from './managed-gateway-session-events.js';

function request(
  overrides: Partial<ManagedGatewayPromptRequest> = {},
): ManagedGatewayPromptRequest {
  return {
    mode: 'gateway',
    turnKind: 'bootstrap',
    tenantId: 'tenant-a',
    workspaceId: 'workspace-a',
    workspaceCwd: '/workspace-a',
    sessionId: 'session-a',
    messageId: 'prompt-a',
    managedClientId: 'managed-client-a',
    prompt: [{ type: 'text', text: 'hello' }],
    ...overrides,
  };
}

describe('ManagedGatewaySessionEvents', () => {
  it('authorizes one managed client and records model and Runtime stages', async () => {
    const events = new ManagedGatewaySessionEvents();
    const input = request();
    events.ensure(input);
    events.markRuntimeStarting(input);
    events.markAgentStarted(input, 0, 'definition-1');
    events.markRuntimeReady(input);
    events.appendAssistantThought(input, 'considering');
    events.appendAssistantDelta(input, 'answer');
    events.complete(input);

    expect(events.authorize(input.sessionId, 'wrong')).toBeUndefined();
    const status = events.authorize(input.sessionId, input.managedClientId);
    expect(status).toMatchObject({
      phase: 'completed',
      runtimeReady: true,
    });
    expect(status).not.toHaveProperty('runtimeClientId');
    const streamed = [];
    for await (const event of events.subscribe(
      input.sessionId,
      input.managedClientId,
      undefined,
      new AbortController().signal,
    )) {
      streamed.push(event.type);
    }
    expect(streamed).toEqual([
      'accepted',
      'runtime_starting',
      'agent_started',
      'runtime_ready',
      'assistant_thought',
      'assistant_delta',
      'completed',
    ]);
  });

  it('records a late Runtime result without reopening a completed turn', async () => {
    const events = new ManagedGatewaySessionEvents();
    const input = request();
    events.ensure(input);
    events.markRuntimeStarting(input);
    events.markAgentStarted(input, 0, 'definition-1');
    events.complete(input);
    events.markRuntimeReady(input);

    expect(
      events.authorize(input.sessionId, input.managedClientId),
    ).toMatchObject({ phase: 'completed', runtimeReady: true });
    const streamed = [];
    for await (const event of events.subscribe(
      input.sessionId,
      input.managedClientId,
      undefined,
      new AbortController().signal,
    )) {
      streamed.push(event.type);
    }
    expect(streamed).toEqual([
      'accepted',
      'runtime_starting',
      'agent_started',
      'completed',
      'runtime_ready',
    ]);
  });

  it('deduplicates exact admission and rejects Session identity reuse', () => {
    const events = new ManagedGatewaySessionEvents();
    const input = request();
    const first = events.ensure(input);
    expect(events.ensure(structuredClone(input))).toEqual(first);
    expect(() =>
      events.ensure(request({ workspaceId: 'workspace-b' })),
    ).toThrow('reused with a different identity');
    expect(() => events.ensure(request({ messageId: 'prompt-b' }))).toThrow(
      'already has an active turn',
    );
  });

  it('preserves one event ring while advancing sequential turns', async () => {
    const events = new ManagedGatewaySessionEvents();
    const first = request();
    events.ensure(first);
    events.markRuntimeReady(first);
    events.complete(first);
    const second = request({
      turnKind: 'continuation',
      messageId: 'prompt-b',
      prompt: [{ type: 'text', text: 'follow up' }],
    });

    expect(events.ensure(second)).toMatchObject({
      promptId: 'prompt-b',
      phase: 'admitted',
      runtimeReady: false,
    });
    events.markRuntimeStarting(second);
    events.markRuntimeReady(second);
    events.complete(second);

    const streamed = [];
    for await (const event of events.subscribe(
      second.sessionId,
      second.managedClientId,
      undefined,
      new AbortController().signal,
    )) {
      streamed.push(event);
    }
    expect(streamed.map((event) => event.id)).toEqual(
      streamed.map((_, index) => index + 1),
    );
    expect(
      streamed
        .filter((event) => event.type === 'accepted')
        .map((event) => event.data),
    ).toEqual([
      { sessionId: 'session-a', promptId: 'prompt-a' },
      { sessionId: 'session-a', promptId: 'prompt-b' },
    ]);
    expect(streamed.at(-1)).toMatchObject({
      type: 'completed',
      data: { sessionId: 'session-a', promptId: 'prompt-b' },
    });
  });

  it('wakes a live subscriber and stops after the terminal', async () => {
    const events = new ManagedGatewaySessionEvents();
    const input = request();
    events.ensure(input);
    const observed: string[] = [];
    const subscription = (async () => {
      for await (const event of events.subscribe(
        input.sessionId,
        input.managedClientId,
        1,
        new AbortController().signal,
      )) {
        observed.push(event.type);
      }
    })();
    await Promise.resolve();
    events.appendAssistantDelta(input, 'x');
    events.complete(input);
    await subscription;
    expect(observed).toEqual(['assistant_delta', 'completed']);
  });

  it('does not skip a terminal appended while a prior event is being yielded', async () => {
    const events = new ManagedGatewaySessionEvents();
    const input = request();
    events.ensure(input);
    const iterator = events
      .subscribe(
        input.sessionId,
        input.managedClientId,
        undefined,
        new AbortController().signal,
      )
      [Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: 'accepted' },
      done: false,
    });
    events.appendAssistantDelta(input, 'x');
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: 'assistant_delta' },
      done: false,
    });
    events.complete(input);
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: 'completed' },
      done: false,
    });
    await expect(iterator.next()).resolves.toEqual({
      value: undefined,
      done: true,
    });
  });

  it('reports a reconnect gap after the bounded preview ring rolls over', async () => {
    const events = new ManagedGatewaySessionEvents();
    const input = request();
    events.ensure(input);
    for (let index = 0; index < 2050; index += 1) {
      events.appendAssistantDelta(input, String(index));
    }
    events.complete(input);
    const streamed = [];
    for await (const event of events.subscribe(
      input.sessionId,
      input.managedClientId,
      1,
      new AbortController().signal,
    )) {
      streamed.push(event);
    }
    expect(streamed).toHaveLength(1);
    expect(streamed[0]).toMatchObject({ type: 'stream_gap' });
    const gap = streamed[0]!;
    const resumed = [];
    for await (const event of events.subscribe(
      input.sessionId,
      input.managedClientId,
      gap.id,
      new AbortController().signal,
    )) {
      resumed.push(event);
    }
    expect(resumed[0]?.id).toBe(gap.id + 1);
    expect(resumed.at(-1)).toMatchObject({ type: 'completed' });
  });

  it('replaces an oversized model event with a terminal preview gap', async () => {
    const events = new ManagedGatewaySessionEvents();
    const input = request();
    events.ensure(input);
    events.appendAssistantDelta(input, 'x'.repeat(800 * 1024));
    events.complete(input);
    const streamed = [];
    for await (const event of events.subscribe(
      input.sessionId,
      input.managedClientId,
      undefined,
      new AbortController().signal,
    )) {
      streamed.push(event.type);
    }
    expect(streamed).toEqual(['accepted', 'stream_gap']);
  });
});
