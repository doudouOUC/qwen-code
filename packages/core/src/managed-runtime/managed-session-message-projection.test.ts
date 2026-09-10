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
import { ManagedSessionMessageProjection } from './managed-session-message-projection.js';
import { LocalManagedSessionResourceStore } from './managed-session-resources.js';
import { managedSessionResourceRoot } from '../utils/sessionStorageUtils.js';
import type { ManagedSessionDurableRef } from './managed-session-records.js';

const DIGEST = 'e'.repeat(64);
const sessionId = '550e8400-e29b-41d4-a716-446655440000';
const sessionKey = { tenantId: 't1', workspaceId: 'w1', sessionId };
const HOLDS = {
  class: 'harness',
  activation: { activationId: 'act-1', epoch: 1 },
} as const;

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

function command(operation: string, commandId: string) {
  return { operation, commandId, sessionKey, contentDigest: DIGEST };
}

interface Harness {
  authority: LocalManagedSessionAuthority;
  projection: ManagedSessionMessageProjection;
  store: LocalManagedSessionResourceStore;
  transcriptPath: string;
  runtimeBaseDir: string;
  close(): Promise<void>;
}

async function createHarness(): Promise<Harness> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-managed-proj-'));
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
    command('claimActivation', 'cmd-act-1'),
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
    authority,
    projection: new ManagedSessionMessageProjection(authority, store),
    store,
    transcriptPath,
    runtimeBaseDir,
    close: () => authority.close(),
  };
}

/** Deliberately varied: a plain turn, model metadata, and a system subtype. */
const records: ChatRecord[] = [
  {
    uuid: 'rec-user-1',
    parentUuid: null,
    sessionId,
    timestamp: '2026-09-01T10:00:00.000Z',
    type: 'user',
    cwd: '/workspace',
    version: '1.2.3',
    message: { role: 'user', parts: [{ text: 'summarise the design docs' }] },
  },
  {
    uuid: 'rec-assistant-1',
    parentUuid: 'rec-user-1',
    sessionId,
    timestamp: '2026-09-01T10:00:05.000Z',
    type: 'assistant',
    cwd: '/workspace',
    version: '1.2.3',
    model: 'qwen3-coder-plus',
    contextWindowSize: 262144,
    usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 45 },
    message: { role: 'model', parts: [{ text: 'Here is the summary.' }] },
  },
  {
    uuid: 'rec-system-1',
    parentUuid: 'rec-assistant-1',
    sessionId,
    timestamp: '2026-09-01T10:00:06.000Z',
    type: 'system',
    subtype: 'slash_command',
    cwd: '/workspace',
    version: '1.2.3',
  },
] as ChatRecord[];

describe('managed session message projection', () => {
  it('round trips records through the authoritative log without losing detail', async () => {
    const harness = await createHarness();
    for (const [index, record] of records.entries()) {
      await harness.projection.commit(
        command('commitMessage', `cmd-msg-${index}`),
        { record },
        HOLDS,
      );
    }

    const projected = await harness.projection.project();
    expect(projected).toEqual(records);
    await harness.close();
  });

  it('keeps no legacy copy of the projected records', async () => {
    const harness = await createHarness();
    await harness.projection.commit(
      command('commitMessage', 'cmd-msg-0'),
      { record: records[0] },
      HOLDS,
    );
    await harness.close();

    const subtypes = (await fs.readFile(harness.transcriptPath, 'utf8'))
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => (JSON.parse(line) as { subtype?: string }).subtype);

    /* The content lives only in the resource the event references, so no
       equivalent user/assistant record may sit beside it in the transcript. */
    expect(new Set(subtypes)).toEqual(
      new Set([
        'session_execution_engine',
        'managed_session_header_v1',
        'managed_session_event_v1',
        'managed_session_commit_v1',
      ]),
    );
  });

  it('survives a cold reopen', async () => {
    const harness = await createHarness();
    for (const [index, record] of records.entries()) {
      await harness.projection.commit(
        command('commitMessage', `cmd-msg-${index}`),
        { record },
        HOLDS,
      );
    }
    await harness.close();

    const lease = await LocalManagedSessionAuthority.acquireWriter({
      runtimeBaseDir: harness.runtimeBaseDir,
      sessionId,
      transcriptPath: harness.transcriptPath,
    });
    const store = LocalManagedSessionResourceStore.create({
      runtimeBaseDir: harness.runtimeBaseDir,
      sessionKey,
    });
    const reopened = await LocalManagedSessionAuthority.open({
      lease,
      sessionKey,
      cwd: '/workspace',
      version: 'test',
      resources: store,
    });
    const projected = await new ManagedSessionMessageProjection(
      reopened,
      store,
    ).project();
    expect(projected).toEqual(records);
    await reopened.close();
  });

  it('refuses a record with no uuid of its own', async () => {
    const harness = await createHarness();
    await expect(
      harness.projection.commit(
        command('commitMessage', 'cmd-msg-bad'),
        { record: { ...records[0], uuid: '' } as ChatRecord },
        HOLDS,
      ),
    ).rejects.toThrow(/must carry its own uuid/);
    await harness.close();
  });

  it('fails the projection when a content body is missing', async () => {
    const harness = await createHarness();
    await harness.projection.commit(
      command('commitMessage', 'cmd-msg-0'),
      { record: records[0] },
      HOLDS,
    );

    /* Dropping the record silently would present a short history as complete. */
    await fs.rm(
      path.join(
        managedSessionResourceRoot(harness.runtimeBaseDir, sessionId),
        'managed-message',
      ),
      { recursive: true, force: true },
    );
    await expect(harness.projection.project()).rejects.toThrow(
      /is not present for session/,
    );
    await harness.close();
  });
});
