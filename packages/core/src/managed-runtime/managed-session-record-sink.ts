/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ChatRecord } from '../services/chatRecordingService.js';
import type {
  LocalManagedSessionAuthority,
  ManagedSessionActor,
} from './managed-session-authority.js';
import { ManagedSessionMessageProjection } from './managed-session-message-projection.js';
import type { LocalManagedSessionResourceStore } from './managed-session-resources.js';

/**
 * The record shapes the message projection can carry today.
 *
 * A Managed log keeps domain content once and projects reader-facing records
 * back out of it, so a record may only be routed here if the projection can
 * reproduce it. Shapes with their own home in the event union or the domain
 * registry -- titles, goal state, artifacts, compaction, turn results, file
 * history -- are deliberately absent until each is mapped.
 */
const CARRIED_SYSTEM_SUBTYPES = new Set([
  'slash_command',
  'at_command',
  'ui_telemetry',
  'attribution_snapshot',
]);

export class ManagedSessionUnmappedRecordError extends Error {
  readonly code = 'managed_session_unmapped_record';

  constructor(record: ChatRecord) {
    super(
      `Managed sessions have no mapping yet for a ${record.type} record` +
        `${record.subtype ? ` with subtype ${record.subtype}` : ''}.`,
    );
    this.name = 'ManagedSessionUnmappedRecordError';
  }
}

/**
 * The controlled sink a Managed-bound recorder writes through.
 *
 * Routing the recorder here is what stops a Managed session from keeping a
 * second, legacy copy of its history beside the authoritative log.
 */
export class ManagedSessionRecordSink {
  private readonly projection: ManagedSessionMessageProjection;
  private sequence = 0;

  constructor(
    private readonly authority: LocalManagedSessionAuthority,
    private readonly resources: LocalManagedSessionResourceStore,
    /** Supplied by the binder, which is the only party that knows the activation. */
    private readonly actor: () => ManagedSessionActor,
  ) {
    this.projection = new ManagedSessionMessageProjection(authority, resources);
  }

  canCarry(record: ChatRecord): boolean {
    if (record.type === 'system') {
      if (record.subtype === 'custom_title') return true;
      if (record.subtype === 'turn_result') return true;
      return (
        record.subtype !== undefined &&
        CARRIED_SYSTEM_SUBTYPES.has(record.subtype)
      );
    }
    if (
      record.type === 'user' ||
      record.type === 'assistant' ||
      record.type === 'tool_result'
    ) {
      return record.subtype === undefined;
    }
    return false;
  }

  /**
   * Refuses rather than falling back. A silent fallback to a direct append
   * would put content in the transcript that the authoritative log does not
   * account for, which is the divergence this layer exists to prevent.
   */
  async write(record: ChatRecord): Promise<void> {
    if (!this.canCarry(record)) {
      throw new ManagedSessionUnmappedRecordError(record);
    }
    if (record.subtype === 'custom_title') {
      await this.commitTitle(record);
      return;
    }
    if (record.subtype === 'turn_result') {
      await this.commitTurnSettled(record);
      return;
    }
    this.sequence += 1;
    await this.projection.commit(
      {
        operation: 'commitMessage',
        commandId: `recorder:${record.uuid}`,
        sessionKey: this.authority.sessionHeader.sessionKey,
        contentDigest: this.authority.sessionHeader.definitionRef.digest,
      },
      { record },
      this.actor(),
    );
  }

  /**
   * A title is not message content: it belongs to the `session_metadata` domain
   * record the session directory reads, so it is committed there rather than
   * projected as a message.
   */
  private async commitTitle(record: ChatRecord): Promise<void> {
    const payload = record.systemPayload as
      | { customTitle?: unknown; titleSource?: unknown }
      | undefined;
    const title = payload?.customTitle;
    if (typeof title !== 'string' || title.length === 0) {
      throw new ManagedSessionUnmappedRecordError(record);
    }
    await this.authority.commitDomainRecord(
      {
        operation: 'renameSession',
        commandId: `recorder:${record.uuid}`,
        sessionKey: this.authority.sessionHeader.sessionKey,
        contentDigest: this.authority.sessionHeader.definitionRef.digest,
      },
      {
        domain: 'session_metadata',
        content: {
          title,
          ...(payload?.titleSource === 'auto' ||
          payload?.titleSource === 'manual'
            ? { titleSource: payload.titleSource }
            : {}),
        },
      },
      { class: 'trusted_entry' },
    );
  }

  /**
   * A turn result is the turn's terminal state, so it is committed as
   * `turn.settled` rather than projected as a message. The whole record becomes
   * the result body, which keeps the error detail and timings the payload
   * carries beyond the fields the event indexes.
   */
  private async commitTurnSettled(record: ChatRecord): Promise<void> {
    const payload = record.systemPayload as
      | { promptId?: unknown; state?: unknown; stopReason?: unknown }
      | undefined;
    const turnId = payload?.promptId;
    const outcome = payload?.state;
    if (
      typeof turnId !== 'string' ||
      turnId.length === 0 ||
      typeof outcome !== 'string' ||
      outcome.length === 0
    ) {
      throw new ManagedSessionUnmappedRecordError(record);
    }
    const resultRef = await this.resources.publish(
      'managed-turn-result',
      Buffer.from(JSON.stringify(record), 'utf8'),
    );
    const actor = this.actor();
    const held = actor.activation;
    await this.authority.appendExecution(
      {
        operation: 'settleTurn',
        commandId: `recorder:${record.uuid}`,
        sessionKey: this.authority.sessionHeader.sessionKey,
        contentDigest: resultRef.digest,
      },
      [
        {
          v: 1,
          sequence: this.authority.committedSequence + 1,
          eventId: `turn:${turnId}`,
          sessionKey: this.authority.sessionHeader.sessionKey,
          kind: 'turn.settled',
          occurredAt: Date.parse(record.timestamp) || Date.now(),
          ...(actor.class === 'harness' && held !== undefined
            ? {
                subject: {
                  type: 'activation',
                  scopeId: held.activationId,
                  activationId: held.activationId,
                  epoch: held.epoch,
                },
              }
            : {}),
          payload: {
            turnId,
            outcome,
            stopReason:
              typeof payload?.stopReason === 'string'
                ? payload.stopReason
                : null,
            resultRef,
            usageRef: null,
            pendingOwnersRef: null,
          },
        },
      ],
      actor,
    );
  }

  /** Reader-facing records rebuilt from the authoritative log. */
  project(): Promise<ChatRecord[]> {
    return this.projection.project();
  }
}
