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

      // Taking over the seal, not colliding with it.
      const second = await activate({ managedSessionLog: true });
      second.config.getChatRecordingService()!.recordUserMessage('second turn');
      await second.config.closeSessionWriter();

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
