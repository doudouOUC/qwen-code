/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ChatRecord } from '../services/chatRecordingService.js';
import {
  MANAGED_SESSION_FORMAT_VERSION,
  MANAGED_SESSION_LIMITS,
  ManagedSessionRecordError,
} from './managed-session-records.js';
import type {
  LocalManagedSessionAuthority,
  ManagedSessionActor,
  ManagedSessionCommand,
  ManagedSessionCommitReceipt,
} from './managed-session-authority.js';
import type { LocalManagedSessionResourceStore } from './managed-session-resources.js';

/**
 * Carries the existing transcript history inside the authoritative log.
 *
 * A Managed session must not append an equivalent legacy record beside each
 * committed event, so the domain content is the only copy and every reader-facing
 * record is projected back out of it. Storing the whole original record as the
 * content body is what makes that projection lossless: subtype, message parts,
 * usage metadata and tool-call details all survive, while the event carries the
 * identity and ordering facts a reader indexes on.
 */
export class ManagedSessionMessageProjection {
  constructor(
    private readonly authority: LocalManagedSessionAuthority,
    private readonly resources: LocalManagedSessionResourceStore,
  ) {}

  /**
   * Commits one record as a `message.committed` event. The caller supplies the
   * actor: the current Harness for model-facing records, or a trusted entry for
   * the projected form of an accepted input, which has no activation to name.
   */
  async commit(
    command: ManagedSessionCommand,
    input: { record: ChatRecord; modelAttemptId?: string | null },
    actor: ManagedSessionActor,
  ): Promise<{ receipt: ManagedSessionCommitReceipt; messageId: string }> {
    const record = input.record;
    if (typeof record.uuid !== 'string' || record.uuid.length === 0) {
      throw new ManagedSessionRecordError(
        'a projected record must carry its own uuid.',
      );
    }
    const body = Buffer.from(JSON.stringify(record), 'utf8');
    const contentRef = await this.resources.publish('managed-message', body);
    const subject =
      actor.class === 'harness' && actor.activation !== undefined
        ? {
            type: 'activation',
            scopeId: actor.activation.activationId,
            activationId: actor.activation.activationId,
            epoch: actor.activation.epoch,
          }
        : undefined;
    const receipt = await this.authority.appendExecution(
      command,
      [
        {
          v: MANAGED_SESSION_FORMAT_VERSION,
          sequence: this.authority.committedSequence + 1,
          eventId: `message:${record.uuid}`,
          sessionKey: command.sessionKey,
          kind: 'message.committed',
          occurredAt: Date.parse(record.timestamp) || Date.now(),
          ...(subject === undefined ? {} : { subject }),
          payload: {
            messageId: record.uuid,
            role: record.type,
            contentRef,
            parentMessageId: record.parentUuid,
            ...(input.modelAttemptId === undefined
              ? {}
              : { modelAttemptId: input.modelAttemptId }),
          },
        },
      ],
      actor,
    );
    return { receipt, messageId: record.uuid };
  }

  /**
   * Rebuilds the reader-facing records from the committed prefix, in commit
   * order. A content body that cannot be resolved fails the projection rather
   * than silently dropping a record, which would present a short history as a
   * complete one.
   */
  async project(): Promise<ChatRecord[]> {
    const records: ChatRecord[] = [];
    let after = 0;
    for (;;) {
      const page = this.authority.readEvents({
        afterSequence: after,
        limit: MANAGED_SESSION_LIMITS.maxReadEvents,
      });
      if (page.length === 0) break;
      for (const event of page) {
        after = event.sequence;
        if (event.kind !== 'message.committed') continue;
        const ref = event.payload['contentRef'];
        const body = await this.resources.read(
          ref as unknown as Parameters<
            LocalManagedSessionResourceStore['read']
          >[0],
        );
        records.push(JSON.parse(body.toString('utf8')) as ChatRecord);
      }
    }
    return records;
  }
}
