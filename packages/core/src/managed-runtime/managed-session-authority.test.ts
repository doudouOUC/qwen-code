/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionWriterLease } from '../services/session-writer-lease.js';
import {
  LocalManagedSessionAuthority,
  ManagedSessionConflictError,
  ManagedSessionUncommittedTailError,
  type ManagedSessionCommand,
} from './managed-session-authority.js';
import {
  ManagedSessionRecordError,
  type ManagedSessionDurableRef,
} from './managed-session-records.js';

const DIGEST = 'b'.repeat(64);
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

interface Fixture {
  runtimeBaseDir: string;
  transcriptPath: string;
  sessionId: string;
}

async function createFixture(sessionId = 'managed-session'): Promise<Fixture> {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'qwen-managed-authority-'),
  );
  temporaryDirectories.add(root);
  const runtimeBaseDir = path.join(root, 'runtime');
  const transcriptPath = path.join(root, 'chats', `${sessionId}.jsonl`);
  await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
  await fs.mkdir(runtimeBaseDir, { recursive: true });
  return { runtimeBaseDir, transcriptPath, sessionId };
}

function sessionKeyFor(fixture: Fixture) {
  return {
    tenantId: 'tenant-1',
    workspaceId: 'workspace-1',
    sessionId: fixture.sessionId,
  };
}

interface OpenedAuthority {
  authority: LocalManagedSessionAuthority;
  release(): Promise<void>;
}

async function openAuthority(
  fixture: Fixture,
  options: { create?: boolean } = {},
): Promise<OpenedAuthority> {
  const lease = await SessionWriterLease.acquire({
    runtimeBaseDir: fixture.runtimeBaseDir,
    sessionId: fixture.sessionId,
    transcriptPath: fixture.transcriptPath,
  });
  try {
    const authority = await LocalManagedSessionAuthority.open({
      lease,
      sessionKey: sessionKeyFor(fixture),
      cwd: '/workspace',
      version: 'test',
      ...(options.create === false
        ? {}
        : {
            create: {
              definitionRef: ref('managed-definition'),
              rootSnapshotRef: ref('managed-root'),
              createdBy: 'daemon',
            },
          }),
    });
    return { authority, release: () => lease.release() };
  } catch (error) {
    await lease.release().catch(() => undefined);
    throw error;
  }
}

function inputCommand(
  fixture: Fixture,
  overrides: Partial<ManagedSessionCommand> = {},
): ManagedSessionCommand {
  return {
    operation: 'submitInput',
    commandId: 'cmd-1',
    sessionKey: sessionKeyFor(fixture),
    contentDigest: DIGEST,
    ...overrides,
  };
}

const inputRequest = {
  inputId: 'in-1',
  turnId: 'turn-1',
  source: 'web_shell',
  contentRef: ref(),
  deadline: null,
  admissionRef: ref(),
  wakeReason: 'input',
};

async function readLines(fixture: Fixture): Promise<string[]> {
  const text = await fs.readFile(fixture.transcriptPath, 'utf8');
  return text.split('\n').filter((line) => line !== '');
}

async function readRecords(
  fixture: Fixture,
): Promise<Array<Record<string, unknown>>> {
  const lines = await readLines(fixture);
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function readBodies(
  fixture: Fixture,
): Promise<Array<Record<string, unknown>>> {
  const records = await readRecords(fixture);
  return records.map(
    (record) => record['managedSession'] as Record<string, unknown>,
  );
}

async function rewrite(fixture: Fixture, lines: string[]): Promise<void> {
  await fs.writeFile(fixture.transcriptPath, `${lines.join('\n')}\n`, 'utf8');
}

describe('managed session authority', () => {
  it('writes a header once and accepts input without a live harness', async () => {
    const fixture = await createFixture();
    const opened = await openAuthority(fixture);
    const receipt = await opened.authority.submitInput(
      inputCommand(fixture),
      inputRequest,
    );
    await opened.release();

    expect(receipt.firstSequence).toBe(1);
    expect(receipt.lastSequence).toBe(2);
    expect(receipt.committedSequence).toBe(2);
    expect(receipt.replayed).toBe(false);

    const records = await readRecords(fixture);
    expect(records.map((record) => record['subtype'])).toEqual([
      'managed_session_header_v1',
      'managed_session_event_v1',
      'managed_session_event_v1',
      'managed_session_commit_v1',
    ]);
    expect(records.every((record) => record['type'] === 'system')).toBe(true);
    expect(
      records.every((record) => record['sessionId'] === fixture.sessionId),
    ).toBe(true);
  });

  it('persists the input and the wake intent in one transaction', async () => {
    const fixture = await createFixture();
    const opened = await openAuthority(fixture);
    await opened.authority.submitInput(inputCommand(fixture), inputRequest);
    await opened.release();

    const bodies = await readBodies(fixture);
    expect(bodies[1]['kind']).toBe('input.accepted');
    expect(bodies[2]['kind']).toBe('wake.requested');
    expect(bodies[3]['eventCount']).toBe(2);
    expect(bodies[3]['firstSequence']).toBe(1);
    expect(bodies[3]['lastSequence']).toBe(2);
    expect(bodies[3]['previousCommitDigest']).toBeNull();
  });

  it('reads the committed prefix back from a cold reopen', async () => {
    const fixture = await createFixture();
    const first = await openAuthority(fixture);
    await first.authority.submitInput(inputCommand(fixture), inputRequest);
    await first.release();

    const second = await openAuthority(fixture, { create: false });
    expect(second.authority.committedSequence).toBe(2);
    expect(second.authority.readEvents().map((event) => event.kind)).toEqual([
      'input.accepted',
      'wake.requested',
    ]);
    await second.release();

    const records = await readRecords(fixture);
    expect(
      records.filter(
        (record) => record['subtype'] === 'managed_session_header_v1',
      ),
    ).toHaveLength(1);
  });

  it('returns the original receipt for a repeated command id', async () => {
    const fixture = await createFixture();
    const opened = await openAuthority(fixture);
    const first = await opened.authority.submitInput(
      inputCommand(fixture),
      inputRequest,
    );
    const replay = await opened.authority.submitInput(
      inputCommand(fixture),
      inputRequest,
    );
    await opened.release();

    expect(replay.transactionId).toBe(first.transactionId);
    expect(replay.replayed).toBe(true);
    expect(replay.lastSequence).toBe(first.lastSequence);
    expect(await readLines(fixture)).toHaveLength(4);
  });

  it('survives a repeated command id across a cold reopen', async () => {
    const fixture = await createFixture();
    const first = await openAuthority(fixture);
    const original = await first.authority.submitInput(
      inputCommand(fixture),
      inputRequest,
    );
    await first.release();

    const second = await openAuthority(fixture, { create: false });
    const replay = await second.authority.submitInput(
      inputCommand(fixture),
      inputRequest,
    );
    await second.release();

    expect(replay.transactionId).toBe(original.transactionId);
    expect(replay.replayed).toBe(true);
    expect(await readLines(fixture)).toHaveLength(4);
  });

  it('rejects the same command id carrying different content', async () => {
    const fixture = await createFixture();
    const opened = await openAuthority(fixture);
    await opened.authority.submitInput(inputCommand(fixture), inputRequest);
    await expect(
      opened.authority.submitInput(
        inputCommand(fixture, { contentDigest: 'c'.repeat(64) }),
        inputRequest,
      ),
    ).rejects.toThrow(ManagedSessionConflictError);
    await opened.release();
    expect(await readLines(fixture)).toHaveLength(4);
  });

  it('rejects a command for another workspace', async () => {
    const fixture = await createFixture();
    const opened = await openAuthority(fixture);
    await expect(
      opened.authority.submitInput(
        inputCommand(fixture, {
          sessionKey: { ...sessionKeyFor(fixture), workspaceId: 'workspace-2' },
        }),
        inputRequest,
      ),
    ).rejects.toThrow(/does not match this session/);
    await opened.release();
    expect(await readLines(fixture)).toHaveLength(1);
  });

  it('rejects a stale expectedSequence', async () => {
    const fixture = await createFixture();
    const opened = await openAuthority(fixture);
    await opened.authority.submitInput(inputCommand(fixture), inputRequest);
    await expect(
      opened.authority.submitInput(
        inputCommand(fixture, { commandId: 'cmd-2', expectedSequence: 0 }),
        { ...inputRequest, inputId: 'in-2' },
      ),
    ).rejects.toThrow(/does not match the committed sequence 2/);
    await opened.release();
  });

  it('chains each commit marker to the previous one', async () => {
    const fixture = await createFixture();
    const opened = await openAuthority(fixture);
    await opened.authority.submitInput(inputCommand(fixture), inputRequest);
    await opened.authority.submitInput(
      inputCommand(fixture, { commandId: 'cmd-2' }),
      { ...inputRequest, inputId: 'in-2' },
    );
    await opened.release();

    const markers = (await readBodies(fixture)).filter(
      (body) => body['transactionId'] !== undefined,
    );
    expect(markers).toHaveLength(2);
    expect(markers[0]['previousCommitDigest']).toBeNull();
    expect(markers[1]['previousCommitDigest']).toMatch(/^[0-9a-f]{64}$/);
    expect(markers[1]['firstSequence']).toBe(3);
  });

  it('bounds a page read and continues from the cursor', async () => {
    const fixture = await createFixture();
    const opened = await openAuthority(fixture);
    await opened.authority.submitInput(inputCommand(fixture), inputRequest);
    await opened.authority.submitInput(
      inputCommand(fixture, { commandId: 'cmd-2' }),
      { ...inputRequest, inputId: 'in-2' },
    );

    const firstPage = opened.authority.readEvents({ limit: 3 });
    expect(firstPage.map((event) => event.sequence)).toEqual([1, 2, 3]);
    const secondPage = opened.authority.readEvents({
      afterSequence: firstPage[firstPage.length - 1].sequence,
      limit: 3,
    });
    expect(secondPage.map((event) => event.sequence)).toEqual([4]);
    expect(() => opened.authority.readEvents({ limit: 0 })).toThrow(
      /limit must be positive/,
    );
    await opened.release();
  });
});

describe('managed session authority activation fences', () => {
  async function withActivation(fixture: Fixture): Promise<OpenedAuthority> {
    const opened = await openAuthority(fixture);
    await opened.authority.submitInput(inputCommand(fixture), inputRequest);
    await opened.authority.appendExecution(
      inputCommand(fixture, {
        operation: 'claimActivation',
        commandId: 'cmd-act-2',
      }),
      [
        {
          v: 1,
          sequence: 3,
          eventId: 'evt-act-2',
          sessionKey: sessionKeyFor(fixture),
          kind: 'activation.changed',
          occurredAt: 1,
          payload: {
            activationId: 'act-2',
            epoch: 2,
            workerId: 'worker-1',
            subject: {
              type: 'activation',
              scopeId: 'scope-1',
              activationId: 'act-2',
              epoch: 2,
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
    return opened;
  }

  function modelAttempt(fixture: Fixture, sequence: number, epoch: number) {
    return {
      v: 1,
      sequence,
      eventId: `evt-model-${epoch}-${sequence}`,
      sessionKey: sessionKeyFor(fixture),
      kind: 'model.attempt',
      occurredAt: 1,
      subject: {
        type: 'activation',
        scopeId: 'scope-1',
        activationId: `act-${epoch}`,
        epoch,
      },
      payload: {
        attemptId: `att-${epoch}`,
        routeRef: ref(),
        inputCheckpointRef: null,
        state: 'started',
        usageRef: null,
      },
    };
  }

  it('tracks the committed activation epoch', async () => {
    const fixture = await createFixture();
    const opened = await withActivation(fixture);
    expect(opened.authority.currentActivationEpoch).toBe(2);
    await opened.release();
  });

  it('recovers the activation epoch from a cold reopen', async () => {
    const fixture = await createFixture();
    const opened = await withActivation(fixture);
    await opened.release();

    const reopened = await openAuthority(fixture, { create: false });
    expect(reopened.authority.currentActivationEpoch).toBe(2);
    await expect(
      reopened.authority.appendExecution(
        inputCommand(fixture, {
          operation: 'appendExecution',
          commandId: 'cmd-stale-cold',
        }),
        [modelAttempt(fixture, 4, 1)],
        { class: 'harness', activation: { activationId: 'act-1', epoch: 1 } },
      ),
    ).rejects.toThrow(/epoch 1 is stale/);
    await reopened.release();
  });

  it('rejects an append from a stale activation epoch', async () => {
    const fixture = await createFixture();
    const opened = await withActivation(fixture);
    await expect(
      opened.authority.appendExecution(
        inputCommand(fixture, {
          operation: 'appendExecution',
          commandId: 'cmd-stale',
        }),
        [modelAttempt(fixture, 4, 1)],
        { class: 'harness', activation: { activationId: 'act-1', epoch: 1 } },
      ),
    ).rejects.toThrow(/epoch 1 is stale/);
    await opened.release();
  });

  it('accepts an append from the current activation', async () => {
    const fixture = await createFixture();
    const opened = await withActivation(fixture);
    const receipt = await opened.authority.appendExecution(
      inputCommand(fixture, {
        operation: 'appendExecution',
        commandId: 'cmd-current',
        expectedSequence: 3,
      }),
      [modelAttempt(fixture, 4, 2)],
      { class: 'harness', activation: { activationId: 'act-2', epoch: 2 } },
    );
    expect(receipt.committedSequence).toBe(4);
    await opened.release();
  });

  it('rejects a harness append whose subject names another activation', async () => {
    const fixture = await createFixture();
    const opened = await withActivation(fixture);
    await expect(
      opened.authority.appendExecution(
        inputCommand(fixture, {
          operation: 'appendExecution',
          commandId: 'cmd-mismatch',
        }),
        [modelAttempt(fixture, 4, 2)],
        { class: 'harness', activation: { activationId: 'act-3', epoch: 2 } },
      ),
    ).rejects.toThrow(/does not match the activation the harness holds/);
    await opened.release();
  });

  it('requires a harness to present the activation it holds', async () => {
    const fixture = await createFixture();
    const opened = await withActivation(fixture);
    await expect(
      opened.authority.appendExecution(
        inputCommand(fixture, {
          operation: 'appendExecution',
          commandId: 'cmd-none',
        }),
        [modelAttempt(fixture, 4, 2)],
        { class: 'harness' },
      ),
    ).rejects.toThrow(/must present the activation it holds/);
    await opened.release();
  });

  it('leaves no partial records behind a rejected append', async () => {
    const fixture = await createFixture();
    const opened = await withActivation(fixture);
    const before = await readLines(fixture);
    await expect(
      opened.authority.appendExecution(
        inputCommand(fixture, {
          operation: 'appendExecution',
          commandId: 'cmd-rejected',
        }),
        [modelAttempt(fixture, 4, 1)],
        { class: 'harness', activation: { activationId: 'act-1', epoch: 1 } },
      ),
    ).rejects.toThrow(ManagedSessionConflictError);
    expect(await readLines(fixture)).toEqual(before);
    await opened.release();
  });
});

describe('managed session authority log integrity', () => {
  it('blocks opening when a transaction has no commit marker', async () => {
    const fixture = await createFixture();
    const opened = await openAuthority(fixture);
    await opened.authority.submitInput(inputCommand(fixture), inputRequest);
    await opened.release();

    const lines = await readLines(fixture);
    lines.pop();
    await rewrite(fixture, lines);

    await expect(openAuthority(fixture, { create: false })).rejects.toThrow(
      ManagedSessionUncommittedTailError,
    );
  });

  it('blocks opening after a crash between the events and the marker', async () => {
    const fixture = await createFixture();
    const opened = await openAuthority(fixture);
    await opened.release();

    // Append events the way a crashed transaction would leave them: through
    // the lease, so the transcript proof stays consistent, but with no marker.
    const lease = await SessionWriterLease.acquire({
      runtimeBaseDir: fixture.runtimeBaseDir,
      sessionId: fixture.sessionId,
      transcriptPath: fixture.transcriptPath,
    });
    await lease.appendJsonLine({
      uuid: 'orphan-1',
      parentUuid: null,
      sessionId: fixture.sessionId,
      timestamp: new Date().toISOString(),
      type: 'system',
      subtype: 'managed_session_event_v1',
      cwd: '/workspace',
      version: 'test',
      managedSession: {
        v: 1,
        sequence: 1,
        eventId: 'orphan-event',
        sessionKey: sessionKeyFor(fixture),
        kind: 'input.accepted',
        occurredAt: 1,
        payload: {
          inputId: 'in-orphan',
          turnId: 'turn-orphan',
          source: 'web_shell',
          contentRef: ref(),
          deadline: null,
          admissionRef: ref(),
        },
      },
    });
    await lease.release();

    await expect(openAuthority(fixture, { create: false })).rejects.toThrow(
      ManagedSessionUncommittedTailError,
    );
  });

  it('refuses a marker whose events were altered', async () => {
    const fixture = await createFixture();
    const opened = await openAuthority(fixture);
    await opened.authority.submitInput(inputCommand(fixture), inputRequest);
    await opened.release();

    const lines = await readLines(fixture);
    const record = JSON.parse(lines[1]) as Record<string, unknown>;
    const body = record['managedSession'] as Record<string, unknown>;
    const payload = body['payload'] as Record<string, unknown>;
    payload['source'] = 'tampered';
    lines[1] = JSON.stringify(record);
    await rewrite(fixture, lines);

    await expect(openAuthority(fixture, { create: false })).rejects.toThrow(
      /does not match the preceding event content/,
    );
  });

  it('refuses a log whose records precede the header', async () => {
    const fixture = await createFixture();
    const opened = await openAuthority(fixture);
    await opened.authority.submitInput(inputCommand(fixture), inputRequest);
    await opened.release();

    const lines = await readLines(fixture);
    await rewrite(fixture, lines.slice(1));

    await expect(openAuthority(fixture, { create: false })).rejects.toThrow(
      /precedes the Managed header/,
    );
  });

  it('refuses a header belonging to another session', async () => {
    const fixture = await createFixture();
    const opened = await openAuthority(fixture);
    await opened.release();

    const lines = await readLines(fixture);
    const record = JSON.parse(lines[0]) as Record<string, unknown>;
    const body = record['managedSession'] as Record<string, unknown>;
    body['sessionKey'] = {
      tenantId: 'tenant-1',
      workspaceId: 'workspace-2',
      sessionId: fixture.sessionId,
    };
    lines[0] = JSON.stringify(record);
    await rewrite(fixture, lines);

    await expect(openAuthority(fixture, { create: false })).rejects.toThrow(
      /belongs to a different session/,
    );
  });

  it('refuses to adopt a transcript that already holds other records', async () => {
    const fixture = await createFixture();
    await rewrite(fixture, [
      JSON.stringify({
        uuid: 'legacy-1',
        parentUuid: null,
        sessionId: fixture.sessionId,
        timestamp: new Date().toISOString(),
        type: 'user',
      }),
    ]);

    await expect(openAuthority(fixture)).rejects.toThrow(
      /history import is not supported yet/,
    );
  });

  it('requires creation parameters for an empty transcript', async () => {
    const fixture = await createFixture();
    await expect(openAuthority(fixture, { create: false })).rejects.toThrow(
      ManagedSessionRecordError,
    );
  });

  it('stops accepting work once an append has failed', async () => {
    const fixture = await createFixture();
    const lease = await SessionWriterLease.acquire({
      runtimeBaseDir: fixture.runtimeBaseDir,
      sessionId: fixture.sessionId,
      transcriptPath: fixture.transcriptPath,
    });
    const authority = await LocalManagedSessionAuthority.open({
      lease,
      sessionKey: sessionKeyFor(fixture),
      cwd: '/workspace',
      version: 'test',
      create: {
        definitionRef: ref('managed-definition'),
        rootSnapshotRef: ref('managed-root'),
        createdBy: 'daemon',
      },
    });

    // Releasing the lease under the authority makes the next append fail for
    // real rather than through an injected stub.
    await lease.release();
    await expect(
      authority.submitInput(inputCommand(fixture), inputRequest),
    ).rejects.toThrow();

    await expect(
      authority.submitInput(
        inputCommand(fixture, { commandId: 'cmd-after-failure' }),
        { ...inputRequest, inputId: 'in-2' },
      ),
    ).rejects.toThrow(/writes stopped after an earlier failure/);
  });
});
