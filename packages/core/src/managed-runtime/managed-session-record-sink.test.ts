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
    const unmapped = [
      'goal_state',
      'chat_compression',
      'turn_result',
      'file_history_snapshot',
    ] as const;
    for (const subtype of unmapped) {
      expect(harness.sink.canCarry(record({ type: 'system', subtype }))).toBe(
        false,
      );
    }
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

  it('refuses an unmapped record instead of appending it directly', async () => {
    const harness = await createHarness();
    const before = await fs.readFile(harness.transcriptPath, 'utf8');
    await expect(
      harness.sink.write(record({ type: 'system', subtype: 'goal_state' })),
    ).rejects.toThrow(ManagedSessionUnmappedRecordError);

    // A silent fallback would put content in the transcript that the
    // authoritative log does not account for.
    expect(await fs.readFile(harness.transcriptPath, 'utf8')).toBe(before);
    await harness.close();
  });
});
