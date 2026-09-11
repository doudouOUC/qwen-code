/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  LocalManagedSessionAuthority,
  type ManagedSessionActor,
} from './managed-session-authority.js';
import { ManagedSessionRecordSink } from './managed-session-record-sink.js';
import type { SessionWriterLease } from '../services/session-writer-lease.js';
import { LocalManagedSessionResourceStore } from './managed-session-resources.js';
import type {
  ManagedSessionDurableRef,
  ManagedSessionKey,
} from './managed-session-records.js';

export interface OpenManagedSessionOptions {
  readonly runtimeBaseDir: string;
  readonly sessionId: string;
  readonly transcriptPath: string;
  readonly sessionKey: ManagedSessionKey;
  readonly cwd: string;
  readonly version: string;
  /** Supplied when creating a session; omitted when reopening one. */
  readonly create?: {
    readonly definitionRef: ManagedSessionDurableRef;
    readonly rootSnapshotRef: ManagedSessionDurableRef;
    readonly createdBy: string;
  };
  /**
   * The activation the Harness currently holds, or undefined when no Harness is
   * advancing the session. Read per record rather than captured, because a
   * session outlives any one activation.
   */
  readonly activation: () =>
    | { readonly activationId: string; readonly epoch: number }
    | undefined;
  /**
   * An already-held writer to adopt instead of acquiring one.
   *
   * Two writers for one session cannot coexist, so a caller that already owns
   * the session's writer hands it in. Its owner keeps the lifecycle: `close()`
   * then leaves the lease alone rather than sealing it.
   */
  readonly lease?: SessionWriterLease;
}

export interface ManagedSession {
  readonly authority: LocalManagedSessionAuthority;
  readonly resources: LocalManagedSessionResourceStore;
  readonly sink: ManagedSessionRecordSink;
  /** Seals the writer, leaving the at-rest barrier in place. */
  close(): Promise<void>;
}

/**
 * Opens a Managed session as one unit: the writer, the resource store that
 * holds event bodies, and the sink a recorder writes through.
 *
 * The pieces were built separately and each verified on its own, but a caller
 * assembling them by hand could easily get the lifecycle wrong -- releasing the
 * writer instead of sealing it, or pointing the store at a different root than
 * the reader. Composing them here keeps those decisions in one place.
 */
export async function openManagedSession(
  options: OpenManagedSessionOptions,
): Promise<ManagedSession> {
  const resources = LocalManagedSessionResourceStore.create({
    runtimeBaseDir: options.runtimeBaseDir,
    sessionKey: options.sessionKey,
  });
  const adopted = options.lease !== undefined;
  const lease =
    options.lease ??
    (await LocalManagedSessionAuthority.acquireWriter({
      runtimeBaseDir: options.runtimeBaseDir,
      sessionId: options.sessionId,
      transcriptPath: options.transcriptPath,
    }));
  let authority: LocalManagedSessionAuthority;
  try {
    authority = await LocalManagedSessionAuthority.open({
      lease,
      sessionKey: options.sessionKey,
      cwd: options.cwd,
      version: options.version,
      resources,
      ...(options.create === undefined ? {} : { create: options.create }),
    });
  } catch (cause) {
    // An adopted writer is not ours to end: releasing it would pull the lease
    // out from under its owner. One we acquired must be released, since sealing
    // an unopened session leaves a barrier with nothing behind it and leaving it
    // held blocks every later attempt.
    if (!adopted) {
      await lease.release().catch(() => undefined);
    }
    throw cause;
  }

  const sink = new ManagedSessionRecordSink(authority, resources, () => {
    const held = options.activation();
    // A record with no activation to name comes from a trusted entry -- an
    // accepted input, projected before any Harness advances the session.
    return held === undefined
      ? ({ class: 'trusted_entry' } satisfies ManagedSessionActor)
      : ({ class: 'harness', activation: held } satisfies ManagedSessionActor);
  });

  return {
    authority,
    resources,
    sink,
    // Sealing is the at-rest barrier, but only the lease's owner may end it.
    close: adopted ? async () => undefined : () => authority.close(),
  };
}
