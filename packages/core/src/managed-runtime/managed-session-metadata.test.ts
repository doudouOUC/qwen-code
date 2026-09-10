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
import { readManagedSessionTitleInfoSync } from '../utils/sessionStorageUtils.js';
import { LocalManagedSessionAuthority } from './managed-session-authority.js';
import { LocalManagedSessionResourceStore } from './managed-session-resources.js';
import type { ManagedSessionDurableRef } from './managed-session-records.js';

const temporaryDirectories = new Set<string>();

afterEach(async () => {
  for (const directory of temporaryDirectories) {
    await fs.rm(directory, { recursive: true, force: true });
  }
  temporaryDirectories.clear();
});

const sessionId = 'session-1';
const sessionKey = {
  tenantId: 'tenant-1',
  workspaceId: 'workspace-1',
  sessionId,
};

interface Harness {
  runtimeBaseDir: string;
  transcriptPath: string;
  store: LocalManagedSessionResourceStore;
}

async function createHarness(): Promise<Harness> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-managed-meta-'));
  temporaryDirectories.add(root);
  const runtimeBaseDir = path.join(root, 'runtime');
  const transcriptPath = path.join(root, 'chats', `${sessionId}.jsonl`);
  await fs.mkdir(runtimeBaseDir, { recursive: true });
  await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
  return {
    runtimeBaseDir,
    transcriptPath,
    store: LocalManagedSessionResourceStore.create({
      runtimeBaseDir,
      sessionKey,
    }),
  };
}

async function withAuthority<T>(
  harness: Harness,
  run: (authority: LocalManagedSessionAuthority) => Promise<T>,
  options: { create?: boolean } = {},
): Promise<T> {
  const lease = await SessionWriterLease.acquire({
    runtimeBaseDir: harness.runtimeBaseDir,
    sessionId,
    transcriptPath: harness.transcriptPath,
  });
  try {
    const create =
      options.create === false
        ? undefined
        : {
            definitionRef: await harness.store.publish(
              'managed-definition',
              Buffer.from('{}', 'utf8'),
            ),
            rootSnapshotRef: await harness.store.publish(
              'managed-root',
              Buffer.from('{}', 'utf8'),
            ),
            createdBy: 'daemon',
          };
    const authority = await LocalManagedSessionAuthority.open({
      lease,
      sessionKey,
      cwd: '/workspace',
      version: 'test',
      resources: harness.store,
      ...(create === undefined ? {} : { create }),
    });
    return await run(authority);
  } finally {
    await lease.release().catch(() => undefined);
  }
}

function renameCommand(commandId: string) {
  return {
    operation: 'renameSession',
    commandId,
    sessionKey,
    contentDigest: 'd'.repeat(64),
  };
}

describe('managed session metadata', () => {
  it('projects a renamed title into the synchronous directory read', async () => {
    const harness = await createHarness();
    await withAuthority(harness, async (authority) => {
      const committed = await authority.commitDomainRecord(
        renameCommand('cmd-rename-1'),
        {
          domain: 'session_metadata',
          content: { title: 'Design review notes', titleSource: 'manual' },
        },
        { class: 'trusted_entry' },
      );
      expect(committed.revision).toBe(1);
      expect(committed.recordRef.kind).toBe('managed-session_metadata');
    });

    expect(
      readManagedSessionTitleInfoSync(
        harness.transcriptPath,
        harness.runtimeBaseDir,
      ),
    ).toEqual({ title: 'Design review notes', source: 'manual' });
  });

  it('projects the latest title and chains each revision', async () => {
    const harness = await createHarness();
    const refs: ManagedSessionDurableRef[] = [];
    await withAuthority(harness, async (authority) => {
      refs.push(
        (
          await authority.commitDomainRecord(
            renameCommand('cmd-rename-1'),
            {
              domain: 'session_metadata',
              content: { title: 'First title', titleSource: 'auto' },
            },
            { class: 'trusted_entry' },
          )
        ).recordRef,
      );
      const second = await authority.commitDomainRecord(
        renameCommand('cmd-rename-2'),
        {
          domain: 'session_metadata',
          content: { title: 'Second title', titleSource: 'manual' },
        },
        { class: 'trusted_entry' },
      );
      expect(second.revision).toBe(2);
      refs.push(second.recordRef);
    });

    expect(
      readManagedSessionTitleInfoSync(
        harness.transcriptPath,
        harness.runtimeBaseDir,
      ),
    ).toEqual({ title: 'Second title', source: 'manual' });

    const body = JSON.parse(
      (await harness.store.read(refs[1])).toString('utf8'),
    ) as { revision: number; previousRecordRef: { resourceId: string } | null };
    expect(body.revision).toBe(2);
    expect(body.previousRecordRef?.resourceId).toBe(refs[0].resourceId);
  });

  it('recovers the revision chain across a cold reopen', async () => {
    const harness = await createHarness();
    await withAuthority(harness, async (authority) => {
      await authority.commitDomainRecord(
        renameCommand('cmd-rename-1'),
        {
          domain: 'session_metadata',
          content: { title: 'Before reopen', titleSource: 'manual' },
        },
        { class: 'trusted_entry' },
      );
    });

    await withAuthority(
      harness,
      async (authority) => {
        expect(authority.domainRecord('session_metadata')?.revision).toBe(1);
        const next = await authority.commitDomainRecord(
          renameCommand('cmd-rename-2'),
          {
            domain: 'session_metadata',
            content: { title: 'After reopen', titleSource: 'manual' },
          },
          { class: 'trusted_entry' },
        );
        expect(next.revision).toBe(2);
      },
      { create: false },
    );

    expect(
      readManagedSessionTitleInfoSync(
        harness.transcriptPath,
        harness.runtimeBaseDir,
      ),
    ).toEqual({ title: 'After reopen', source: 'manual' });
  });

  it('reports no custom title for a managed session never renamed', async () => {
    const harness = await createHarness();
    await withAuthority(harness, async () => undefined);

    expect(
      readManagedSessionTitleInfoSync(
        harness.transcriptPath,
        harness.runtimeBaseDir,
      ),
    ).toEqual({});
  });

  it('defers to the legacy reader for a non-managed transcript', async () => {
    const harness = await createHarness();
    await fs.writeFile(
      harness.transcriptPath,
      `${JSON.stringify({
        uuid: 'legacy-1',
        parentUuid: null,
        sessionId,
        timestamp: new Date().toISOString(),
        type: 'system',
        subtype: 'custom_title',
        customTitle: 'Legacy title',
        titleSource: 'manual',
      })}\n`,
      'utf8',
    );

    expect(
      readManagedSessionTitleInfoSync(
        harness.transcriptPath,
        harness.runtimeBaseDir,
      ),
    ).toBeUndefined();
  });

  it('refuses a registered domain that is not enabled', async () => {
    const harness = await createHarness();
    await withAuthority(harness, async (authority) => {
      await expect(
        authority.commitDomainRecord(
          renameCommand('cmd-schedule'),
          { domain: 'schedule', content: {} },
          { class: 'trusted_entry' },
        ),
      ).rejects.toThrow(/registered but not enabled for submission/);
    });
  });

  it('refuses a domain record when no resource store is available', async () => {
    const harness = await createHarness();
    const lease = await SessionWriterLease.acquire({
      runtimeBaseDir: harness.runtimeBaseDir,
      sessionId,
      transcriptPath: harness.transcriptPath,
    });
    const authority = await LocalManagedSessionAuthority.open({
      lease,
      sessionKey,
      cwd: '/workspace',
      version: 'test',
      create: {
        definitionRef: await harness.store.publish(
          'managed-definition',
          Buffer.from('{}', 'utf8'),
        ),
        rootSnapshotRef: await harness.store.publish(
          'managed-root',
          Buffer.from('{}', 'utf8'),
        ),
        createdBy: 'daemon',
      },
    });
    await expect(
      authority.commitDomainRecord(
        renameCommand('cmd-rename-1'),
        {
          domain: 'session_metadata',
          content: { title: 'No store', titleSource: 'manual' },
        },
        { class: 'trusted_entry' },
      ),
    ).rejects.toThrow(/resource store is required/);
    await lease.release();
  });
});
