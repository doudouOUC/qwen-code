/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Config, type ConfigParameters } from './config.js';
import { Storage } from './storage.js';
import { getSessionWriterLockPath } from '../services/session-writer-lease.js';
import {
  MANAGED_SESSION_COMMIT_SUBTYPE,
  MANAGED_SESSION_EVENT_SUBTYPE,
  MANAGED_SESSION_HEADER_SUBTYPE,
} from '../managed-runtime/managed-session-records.js';
import { isManagedSessionTranscriptSync } from '../utils/sessionStorageUtils.js';

const sessionId = '550e8400-e29b-41d4-a716-4466554400aa';
const temporaryDirectories = new Set<string>();

afterEach(async () => {
  for (const directory of temporaryDirectories) {
    await rm(directory, { recursive: true, force: true });
  }
  temporaryDirectories.clear();
  vi.restoreAllMocks();
});

interface Fixture {
  config: Config;
  runtimeBaseDir: string;
  transcriptPath: string;
}

type Activate = (options: { managedSessionLog: boolean }) => Promise<Fixture>;

async function withWorkspace(run: (activate: Activate) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'qwen-managed-log-'));
  temporaryDirectories.add(root);
  const workspace = path.join(root, 'workspace');
  const runtimeBaseDir = path.join(root, 'runtime');
  await mkdir(workspace, { recursive: true });
  await Storage.runWithResolvedRuntimeBaseDir(runtimeBaseDir, async () => {
    await run(async (options) => {
      const params: ConfigParameters = {
        sessionId,
        cwd: workspace,
        targetDir: workspace,
        debugMode: false,
        model: 'qwen3-coder-plus',
        chatRecording: true,
        experimentalZedIntegration: true,
        sessionWriterLeaseEnabled: true,
        managedToolSessionFactory: () => {
          throw new Error('must not create tools');
        },
        ...(options.managedSessionLog
          ? { managedSessionLogEnabled: true }
          : {}),
      };
      const config = new Config(params);
      const transcriptPath = config.getTranscriptPath();
      await mkdir(path.dirname(transcriptPath), { recursive: true });
      vi.spyOn(
        config as unknown as { initializeInternal(): Promise<void> },
        'initializeInternal',
      ).mockResolvedValue(undefined);
      await config.initialize({ sessionExecutionEngine: 'managed' });
      return { config, runtimeBaseDir, transcriptPath };
    });
  });
}

async function transcriptRecords(
  transcriptPath: string,
): Promise<Array<Record<string, unknown>>> {
  const raw = await readFile(transcriptPath, 'utf8');
  return raw
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('managed session log activation', () => {
  it('records a managed session through the authority and seals on close', async () => {
    await withWorkspace(async (activate) => {
      const fixture = await activate({ managedSessionLog: true });
      const recorder = fixture.config.getChatRecordingService()!;
      recorder.recordUserMessage('summarise the docs');
      await recorder.flush();

      const records = await transcriptRecords(fixture.transcriptPath);
      const subtypes = records.map((entry) => entry['subtype']);

      // The authority writes the engine record first so maintenance guards see
      // a managed session, then the header that makes the log authoritative.
      expect(subtypes[0]).toBe('session_execution_engine');
      expect(
        (records[0]['systemPayload'] as Record<string, unknown>)['engine'],
      ).toBe('managed');
      expect(subtypes[1]).toBe(MANAGED_SESSION_HEADER_SUBTYPE);
      expect(isManagedSessionTranscriptSync(fixture.transcriptPath)).toBe(true);
      expect(fixture.config.getSessionExecutionEngine()).toBe('managed');

      // The user message reached the log as a Managed event, not as a raw
      // legacy line: it is inside a committed transaction.
      expect(subtypes).toContain(MANAGED_SESSION_EVENT_SUBTYPE);
      expect(subtypes).toContain(MANAGED_SESSION_COMMIT_SUBTYPE);
      expect(subtypes).not.toContain(undefined);

      await fixture.config.closeSessionWriter();

      // Releasing would delete the lock and leave the Managed log unguarded.
      const lock = JSON.parse(
        await readFile(
          getSessionWriterLockPath(fixture.runtimeBaseDir, sessionId),
          'utf8',
        ),
      ) as Record<string, unknown>;
      expect(lock['state']).toBe('sealed');
    });
  });

  it('reopens a sealed managed session and continues the same log', async () => {
    await withWorkspace(async (activate) => {
      const first = await activate({ managedSessionLog: true });
      first.config.getChatRecordingService()!.recordUserMessage('first turn');
      await first.config.closeSessionWriter();
      const afterFirst = await transcriptRecords(first.transcriptPath);

      // A reader sees the conversation, not the wrapper records carrying it.
      const loaded = await first.config
        .getSessionService()
        .loadSession(sessionId);
      expect(loaded?.conversation.messages.map((entry) => entry.type)).toEqual([
        'user',
      ]);
      expect(loaded?.lastCompletedUuid).toBe(
        loaded?.conversation.messages[0].uuid,
      );

      // Taking over the seal, not colliding with it.
      const second = await activate({ managedSessionLog: true });
      second.config.getChatRecordingService()!.recordUserMessage('second turn');
      await second.config.closeSessionWriter();

      const reloaded = await second.config
        .getSessionService()
        .loadSession(sessionId);
      expect(
        reloaded?.conversation.messages.map((entry) => entry.type),
      ).toEqual(['user', 'user']);

      const records = await transcriptRecords(second.transcriptPath);
      const subtypes = records.map((entry) => entry['subtype']);
      expect(
        subtypes.filter((value) => value === MANAGED_SESSION_HEADER_SUBTYPE),
      ).toHaveLength(1);
      expect(
        subtypes.filter((value) => value === 'session_execution_engine'),
      ).toHaveLength(1);

      // The first session's records are still there, with the second appended.
      expect(records.slice(0, afterFirst.length)).toEqual(afterFirst);
      expect(
        subtypes.filter((value) => value === MANAGED_SESSION_EVENT_SUBTYPE)
          .length,
      ).toBeGreaterThan(
        afterFirst.filter(
          (entry) => entry['subtype'] === MANAGED_SESSION_EVENT_SUBTYPE,
        ).length,
      );

      const lock = JSON.parse(
        await readFile(
          getSessionWriterLockPath(second.runtimeBaseDir, sessionId),
          'utf8',
        ),
      ) as Record<string, unknown>;
      expect(lock['state']).toBe('sealed');
    });
  });

  it('restores a managed session from its projected records', async () => {
    await withWorkspace(async (activate) => {
      const fixture = await activate({ managedSessionLog: true });
      const recorder = fixture.config.getChatRecordingService()!;
      recorder.recordUserMessage('first turn');
      recorder.recordUserMessage('second turn');
      await fixture.config.closeSessionWriter();

      const service = fixture.config.getSessionService();
      const projection = await service.readRestoreProjection(sessionId, {
        replay: { kind: 'all', hideInheritedHistory: false },
      });

      // The replay page is the conversation, not the wrapper records.
      expect(projection?.replay?.records.map((entry) => entry.type)).toEqual([
        'user',
        'user',
      ]);
      expect(projection?.replay?.hasMore).toBe(false);
      expect(projection?.runtime.apiHistory.length).toBeGreaterThan(0);
      expect(projection?.runtime.recording.executionEngine).toBe('managed');

      // A record written next chains from the last thing a reader saw.
      const records = projection!.replay!.records;
      expect(projection?.runtime.recording.lastCompletedUuid).toBe(
        records[records.length - 1].uuid,
      );

      const recent = await service.readRestoreProjection(sessionId, {
        replay: { kind: 'recent', limit: 1, hideInheritedHistory: false },
      });
      expect(recent?.replay?.records).toHaveLength(1);
      expect(recent?.replay?.hasMore).toBe(true);
      expect(recent?.replay?.anchorRecordId).toBe(
        recent?.replay?.records[0].uuid,
      );
    });
  });

  it('refuses to restore a managed session from another project', async () => {
    await withWorkspace(async (activate) => {
      const fixture = await activate({ managedSessionLog: true });
      fixture.config.getChatRecordingService()!.recordUserMessage('first turn');
      await fixture.config.closeSessionWriter();

      const service = fixture.config.getSessionService();
      vi.spyOn(
        service as unknown as {
          sessionBelongsToCurrentProject(): Promise<boolean>;
        },
        'sessionBelongsToCurrentProject',
      ).mockResolvedValue(false);

      await expect(
        service.readRestoreProjection(sessionId, {
          replay: { kind: 'all', hideInheritedHistory: false },
        }),
      ).rejects.toThrow();
    });
  });

  it('loads a managed session that nothing has been said in yet', async () => {
    await withWorkspace(async (activate) => {
      const first = await activate({ managedSessionLog: true });
      await first.config.closeSessionWriter();

      // The header is proof the session exists, so an empty history must not
      // read as a missing session -- that would make the session unopenable.
      const loaded = await first.config
        .getSessionService()
        .loadSession(sessionId);
      expect(loaded?.conversation.messages).toEqual([]);
      expect(loaded?.lastCompletedUuid).toBeNull();

      const second = await activate({ managedSessionLog: true });
      second.config.getChatRecordingService()!.recordUserMessage('first turn');
      await second.config.closeSessionWriter();
      const reloaded = await second.config
        .getSessionService()
        .loadSession(sessionId);
      expect(reloaded?.conversation.messages).toHaveLength(1);
    });
  });

  it('leaves a managed host on the legacy transcript when the log is off', async () => {
    await withWorkspace(async (activate) => {
      const fixture = await activate({ managedSessionLog: false });
      const recorder = fixture.config.getChatRecordingService()!;
      recorder.recordUserMessage('summarise the docs');
      await recorder.flush();

      const records = await transcriptRecords(fixture.transcriptPath);
      expect(records.map((entry) => entry['subtype'])).toEqual([
        'session_execution_engine',
        undefined,
      ]);
      expect(records[1]['type']).toBe('user');
      expect(isManagedSessionTranscriptSync(fixture.transcriptPath)).toBe(
        false,
      );

      await fixture.config.closeSessionWriter();

      // A legacy close still releases, which removes the lock outright.
      await expect(
        stat(getSessionWriterLockPath(fixture.runtimeBaseDir, sessionId)),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });
});
