/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Storage } from '../config/storage.js';
import type { ChatRecord } from '../services/chatRecordingService.js';
import { LocalManagedSessionAuthority } from './managed-session-authority.js';
import {
  ManagedSessionRecordSink,
  ManagedSessionUnmappedRecordError,
} from './managed-session-record-sink.js';
import { LocalManagedSessionResourceStore } from './managed-session-resources.js';
import { readManagedSessionTitleInfoSync } from '../utils/sessionStorageUtils.js';
import type { ManagedSessionDurableRef } from './managed-session-records.js';

const DIGEST = 'f'.repeat(64);
const sessionId = '550e8400-e29b-41d4-a716-446655440000';
const sessionKey = { tenantId: 't1', workspaceId: 'w1', sessionId };
const temporaryDirectories = new Set<string>();

afterEach(async () => {
  for (const directory of temporaryDirectories) {
    await fs.rm(directory, { recursive: true, force: true });
  }
  temporaryDirectories.clear();
});

function ref(kind = 'managed-test'): ManagedSessionDurableRef {
  return {
    resourceId: 'res-1',
    kind,
    schemaVersion: 1,
    byteLength: 4,
    digest: DIGEST,
  };
}

function record(overrides: Partial<ChatRecord>): ChatRecord {
  return {
    uuid: 'rec-1',
    parentUuid: null,
    sessionId,
    timestamp: '2026-09-01T10:00:00.000Z',
    type: 'user',
    cwd: '/workspace',
    version: '1.2.3',
    ...overrides,
  } as ChatRecord;
}

interface Harness {
  sink: ManagedSessionRecordSink;
  authority: LocalManagedSessionAuthority;
  store: LocalManagedSessionResourceStore;
  transcriptPath: string;
  runtimeBaseDir: string;
  close(): Promise<void>;
}

async function createHarness(): Promise<Harness> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-managed-sink-'));
  temporaryDirectories.add(root);
  const projectRoot = path.join(root, 'project');
  const runtimeBaseDir = path.join(root, 'runtime');
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.mkdir(runtimeBaseDir, { recursive: true });
  const transcriptPath = path.join(
    new Storage(projectRoot, runtimeBaseDir).getProjectDir(),
    'chats',
    `${sessionId}.jsonl`,
  );
  await fs.mkdir(path.dirname(transcriptPath), { recursive: true });

  const store = LocalManagedSessionResourceStore.create({
    runtimeBaseDir,
    sessionKey,
  });
  const lease = await LocalManagedSessionAuthority.acquireWriter({
    runtimeBaseDir,
    sessionId,
    transcriptPath,
  });
  const authority = await LocalManagedSessionAuthority.open({
    lease,
    sessionKey,
    cwd: projectRoot,
    version: 'test',
    resources: store,
    create: {
      definitionRef: ref('managed-definition'),
      rootSnapshotRef: ref('managed-root'),
      createdBy: 'daemon',
    },
  });
  await authority.appendExecution(
    {
      operation: 'claimActivation',
      commandId: 'cmd-act-1',
      sessionKey,
      contentDigest: DIGEST,
    },
    [
      {
        v: 1,
        sequence: 1,
        eventId: 'evt-act-1',
        sessionKey,
        kind: 'activation.changed',
        occurredAt: 1,
        payload: {
          activationId: 'act-1',
          epoch: 1,
          workerId: 'worker-1',
          subject: {
            type: 'activation',
            scopeId: 'act-1',
            activationId: 'act-1',
            epoch: 1,
          },
          phase: 'active',
          leaseDurationMs: 60_000,
          expiresAt: 2,
          installRef: ref(),
          boundaryRef: null,
        },
      },
    ],
    { class: 'coordinator' },
  );

  return {
    sink: new ManagedSessionRecordSink(authority, store, () => ({
      class: 'harness',
      activation: { activationId: 'act-1', epoch: 1 },
    })),
    authority,
    store,
    transcriptPath,
    runtimeBaseDir,
    close: () => authority.close(),
  };
}

async function transcriptSubtypes(
  harness: Harness,
): Promise<Array<string | undefined>> {
  const text = await fs.readFile(harness.transcriptPath, 'utf8');
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => (JSON.parse(line) as { subtype?: string }).subtype);
}

describe('managed session record sink', () => {
  it('carries the record shapes the projection can reproduce', async () => {
    const harness = await createHarness();
    expect(harness.sink.canCarry(record({ type: 'user' }))).toBe(true);
    expect(harness.sink.canCarry(record({ type: 'assistant' }))).toBe(true);
    expect(harness.sink.canCarry(record({ type: 'tool_result' }))).toBe(true);
    expect(
      harness.sink.canCarry(
        record({ type: 'system', subtype: 'slash_command' }),
      ),
    ).toBe(true);
    await harness.close();
  });

  it('refuses shapes that have their own home and are not mapped yet', async () => {
    const harness = await createHarness();
    // A rewind belongs to the history_rewind domain and a parent session to the
    // child_run lineage; neither is routed yet, so both are refused.
    const unmapped = ['rewind', 'parent_session'] as const;
    for (const subtype of unmapped) {
      expect(harness.sink.canCarry(record({ type: 'system', subtype }))).toBe(
        false,
      );
    }
    await harness.close();
  });

  it('commits a compaction as the range of history it replaces', async () => {
    const harness = await createHarness();
    const message = record({
      uuid: 'rec-user-1',
      message: { role: 'user', parts: [{ text: 'summarise the docs' }] },
    });
    await harness.sink.write(message);

    const compression = record({
      uuid: 'rec-compact-1',
      type: 'system',
      subtype: 'chat_compression',
      systemPayload: {
        info: { originalTokenCount: 100, newTokenCount: 10 },
        compressedHistory: [{ role: 'user', parts: [{ text: 'summary' }] }],
      },
    } as Partial<ChatRecord>);
    await harness.sink.write(compression);

    const compacted = harness.authority
      .readEvents()
      .filter((event) => event.kind === 'context.compacted');
    expect(compacted).toHaveLength(1);
    expect(compacted[0].payload['replacedMessageIds']).toEqual(['rec-user-1']);
    expect(compacted[0].payload['fromSequence']).toBe(1);

    // The snapshot reads back whole, and a compaction is not message content,
    // so it stays out of the message projection.
    const body = await harness.store.read(
      compacted[0].payload['summaryRef'] as unknown as ManagedSessionDurableRef,
    );
    expect(JSON.parse(body.toString('utf8'))).toEqual(compression);
    expect(await harness.sink.project()).toEqual([message]);

    await expect(
      harness.sink.write(
        record({
          uuid: 'rec-compact-2',
          type: 'system',
          subtype: 'chat_compression',
          systemPayload: { info: {} } as never,
        }),
      ),
    ).rejects.toThrow(ManagedSessionUnmappedRecordError);
    await harness.close();
  });

  it('writes a carried record into the authoritative log only', async () => {
    const harness = await createHarness();
    const carried = record({
      uuid: 'rec-user-1',
      message: { role: 'user', parts: [{ text: 'hello' }] },
    });
    await harness.sink.write(carried);

    expect(await harness.sink.project()).toEqual([carried]);
    await harness.close();

    expect(new Set(await transcriptSubtypes(harness))).toEqual(
      new Set([
        'session_execution_engine',
        'managed_session_header_v1',
        'managed_session_event_v1',
        'managed_session_commit_v1',
      ]),
    );
  });

  it('routes a title into the session_metadata record the directory reads', async () => {
    const harness = await createHarness();
    await harness.sink.write(
      record({
        uuid: 'rec-title-1',
        type: 'system',
        subtype: 'custom_title',
        systemPayload: { customTitle: 'Recorded title', titleSource: 'manual' },
      } as Partial<ChatRecord>),
    );
    await harness.close();

    /* A title is not message content, so it must reach the directory through
       the session_metadata domain record, not the message projection. */
    expect(
      readManagedSessionTitleInfoSync(
        harness.transcriptPath,
        harness.runtimeBaseDir,
      ),
    ).toEqual({ title: 'Recorded title', source: 'manual' });
    expect(await harness.sink.project()).toEqual([]);
  });

  it('settles the turn instead of projecting the result as a message', async () => {
    const harness = await createHarness();
    const result = record({
      uuid: 'rec-turn-1',
      type: 'system',
      subtype: 'turn_result',
      systemPayload: {
        promptId: 'turn-1',
        state: 'completed',
        stopReason: 'end_turn',
      },
    } as Partial<ChatRecord>);
    await harness.sink.write(result);

    const settled = harness.authority
      .readEvents()
      .filter((event) => event.kind === 'turn.settled');
    expect(settled).toHaveLength(1);
    expect(settled[0].payload['turnId']).toBe('turn-1');
    expect(settled[0].payload['outcome']).toBe('completed');
    expect(settled[0].payload['stopReason']).toBe('end_turn');

    /* The terminal state is an event, not message content. */
    expect(await harness.sink.project()).toEqual([]);

    /* The whole record is retained, so error detail and timings survive. */
    const body = await harness.store.read(
      settled[0].payload['resultRef'] as never,
    );
    expect(JSON.parse(body.toString('utf8'))).toEqual(result);
    await harness.close();
  });

  it('refuses a turn result with no prompt id or state', async () => {
    const harness = await createHarness();
    await expect(
      harness.sink.write(
        record({
          uuid: 'rec-turn-bad',
          type: 'system',
          subtype: 'turn_result',
          systemPayload: { state: 'completed' },
        } as Partial<ChatRecord>),
      ),
    ).rejects.toThrow(ManagedSessionUnmappedRecordError);
    await harness.close();
  });

  it('commits a goal snapshot as the goal domain record', async () => {
    const harness = await createHarness();
    const goal = record({
      uuid: 'rec-goal-1',
      type: 'system',
      subtype: 'goal_state',
      systemPayload: {
        v: 2,
        cause: 'create',
        snapshot: { activity: 'idle' },
      },
    } as unknown as Partial<ChatRecord>);
    await harness.sink.write(goal);

    const committed = harness.authority
      .readEvents()
      .filter((event) => event.kind === 'domain.committed');
    expect(committed).toHaveLength(1);
    expect(committed[0].payload['domain']).toBe('goal_state');

    // The whole record is the body, so goal recovery reads what was written,
    // and the goal stays out of the message channel.
    const body = JSON.parse(
      (
        await harness.store.read(
          committed[0].payload[
            'recordRef'
          ] as unknown as ManagedSessionDurableRef,
        )
      ).toString('utf8'),
    ) as { record: unknown; revision: number };
    expect(body.record).toEqual(goal);
    expect(body.revision).toBe(1);
    expect(await harness.sink.project()).toEqual([]);
    await harness.close();
  });

  it('carries a subtyped user message on the message channel', async () => {
    const harness = await createHarness();
    const runtimeMessage = record({
      uuid: 'rec-goal-runtime-1',
      subtype: 'goal_runtime',
      message: { role: 'user', parts: [{ text: 'continue the goal' }] },
    } as Partial<ChatRecord>);
    await harness.sink.write(runtimeMessage);

    // The subtype survives the round trip, which is why it can ride here.
    expect(await harness.sink.project()).toEqual([runtimeMessage]);
    await harness.close();
  });

  it('refuses an unmapped record instead of appending it directly', async () => {
    const harness = await createHarness();
    const before = await fs.readFile(harness.transcriptPath, 'utf8');
    await expect(
      harness.sink.write(
        record({ type: 'system', subtype: 'file_history_snapshot' }),
      ),
    ).rejects.toThrow(ManagedSessionUnmappedRecordError);

    // A silent fallback would put content in the transcript that the
    // authoritative log does not account for.
    expect(await fs.readFile(harness.transcriptPath, 'utf8')).toBe(before);
    await harness.close();
  });
});
