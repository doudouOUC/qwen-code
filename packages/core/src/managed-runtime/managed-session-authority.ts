/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import type { SessionWriterLease } from '../services/session-writer-lease.js';
import type { LocalManagedSessionResourceStore } from './managed-session-resources.js';
import { managedToolDigest } from '../tools/managed-tool-protocol.js';
import {
  MANAGED_SESSION_COMMIT_SUBTYPE,
  MANAGED_SESSION_EVENT_SUBTYPE,
  MANAGED_SESSION_FORMAT_VERSION,
  MANAGED_SESSION_HEADER_SUBTYPE,
  MANAGED_SESSION_LIMITS,
  MANAGED_SESSION_MINIMUM_READER,
  ManagedSessionRecordError,
  assertManagedSessionDomainEnabled,
  assertManagedSessionEventActor,
  assertManagedSessionTransaction,
  managedSessionEventsDigest,
  managedSessionKeysEqual,
  parseManagedSessionCommitMarker,
  parseManagedSessionEvent,
  parseManagedSessionHeader,
  parseManagedSessionRecordJson,
  type ManagedSessionActorClass,
  type ManagedSessionDomain,
  type ManagedSessionCommitMarker,
  type ManagedSessionDurableRef,
  type ManagedSessionEvent,
  type ManagedSessionHeader,
  type ManagedSessionKey,
} from './managed-session-records.js';

export type ManagedSessionRecordBody =
  | ManagedSessionHeader
  | ManagedSessionEvent
  | ManagedSessionCommitMarker;

export interface ManagedSessionCommand {
  readonly operation: string;
  readonly commandId: string;
  readonly sessionKey: ManagedSessionKey;
  readonly contentDigest: string;
  /** Required for execution commands; the caller's view of the log tail. */
  readonly expectedSequence?: number;
}

export interface ManagedSessionActor {
  readonly class: ManagedSessionActorClass;
  /** The activation the Harness holds; rejected once a later epoch exists. */
  readonly activation?: {
    readonly activationId: string;
    readonly epoch: number;
  };
}

export interface ManagedSessionDomainReceipt {
  readonly receipt: ManagedSessionCommitReceipt;
  readonly recordRef: ManagedSessionDurableRef;
  readonly revision: number;
}

export interface ManagedSessionActivationState {
  readonly activationId: string;
  readonly epoch: number;
  readonly phase: string;
}

export interface ManagedSessionCommitReceipt {
  readonly transactionId: string;
  readonly commandId: string;
  readonly operation: string;
  readonly firstSequence: number;
  readonly lastSequence: number;
  readonly committedSequence: number;
  /** True when the original commit was returned instead of appending again. */
  readonly replayed: boolean;
}

export interface ManagedSessionInputRequest {
  readonly inputId: string;
  readonly turnId: string;
  readonly source: string;
  readonly contentRef: ManagedSessionDurableRef;
  readonly deadline: number | null;
  readonly admissionRef: ManagedSessionDurableRef;
  readonly wakeReason: string;
}

export class ManagedSessionConflictError extends ManagedSessionRecordError {
  override readonly code = 'managed_session_conflict';

  constructor(message: string) {
    super(message);
    this.name = 'ManagedSessionConflictError';
  }
}

/**
 * A crash between the last event and its commit marker. The remedy is to
 * truncate the tail under an exclusive writer, which needs a lease capability
 * that does not exist yet, so the authority stays blocked instead of reusing
 * the sequences the tail already consumed.
 */
export class ManagedSessionUncommittedTailError extends ManagedSessionRecordError {
  override readonly code = 'managed_session_uncommitted_tail';

  constructor(
    message: string,
    readonly uncommittedRecords: number,
  ) {
    super(message);
    this.name = 'ManagedSessionUncommittedTailError';
  }
}

interface CommittedTransaction {
  readonly receipt: ManagedSessionCommitReceipt;
  readonly contentDigest: string;
}

export interface OpenManagedSessionAuthorityOptions {
  readonly lease: SessionWriterLease;
  readonly sessionKey: ManagedSessionKey;
  readonly cwd: string;
  readonly version: string;
  /** Supplied when creating a session; ignored once a header exists. */
  readonly create?: {
    readonly definitionRef: ManagedSessionDurableRef;
    readonly rootSnapshotRef: ManagedSessionDurableRef;
    readonly createdBy: string;
  };
  readonly now?: () => number;
  /** Required only for domain records, whose bodies live in resources. */
  readonly resources?: LocalManagedSessionResourceStore;
}

function commandKey(operation: string, commandId: string): string {
  return `${operation}\u0000${commandId}`;
}

/**
 * The authoritative writer for one Managed Session. Every append goes through
 * the session writer lease, which already serialises writes, re-checks
 * ownership per line and syncs the file, so this class adds the transaction
 * boundary, idempotency and eligibility rules on top rather than a second
 * write path.
 */
export class LocalManagedSessionAuthority {
  private constructor(
    private readonly lease: SessionWriterLease,
    private readonly sessionKey: ManagedSessionKey,
    private readonly cwd: string,
    private readonly version: string,
    private readonly now: () => number,
    private readonly header: ManagedSessionHeader,
    private readonly events: ManagedSessionEvent[],
    private readonly transactions: Map<string, CommittedTransaction>,
    private committed: number,
    private lastMarkerDigest: string | null,
    private lastRecordUuid: string | null,
    private activation: ManagedSessionActivationState | undefined,
    private readonly resources: LocalManagedSessionResourceStore | undefined,
  ) {}

  private writeFailure: Error | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly eventIds = new Set<string>();
  private readonly domainRecords = new Map<
    string,
    { revision: number; recordRef: ManagedSessionDurableRef }
  >();

  get committedSequence(): number {
    return this.committed;
  }

  get sessionHeader(): ManagedSessionHeader {
    return this.header;
  }

  /** The highest activation epoch committed so far; 0 when none exists. */
  /** The activation the log currently records, if any. */
  get currentActivation(): ManagedSessionActivationState | undefined {
    return this.activation;
  }

  static async open(
    options: OpenManagedSessionAuthorityOptions,
  ): Promise<LocalManagedSessionAuthority> {
    const now = options.now ?? (() => Date.now());
    const scan = await readManagedSessionLog(
      options.lease.transcriptPath,
      options.sessionKey,
    );
    if (scan.uncommitted > 0) {
      throw new ManagedSessionUncommittedTailError(
        `session log ends with ${scan.uncommitted} uncommitted record(s); truncation under an exclusive writer is required before appending.`,
        scan.uncommitted,
      );
    }
    let header = scan.header;
    let lastRecordUuid = scan.lastRecordUuid;
    if (header === undefined) {
      if (scan.foreignRecords > scan.engineRecords) {
        throw new ManagedSessionRecordError(
          'session log has existing records but no Managed header; history import is not supported yet.',
        );
      }
      if (options.create === undefined) {
        throw new ManagedSessionRecordError(
          'session log has no Managed header and no creation parameters were supplied.',
        );
      }
      header = parseManagedSessionHeader({
        formatVersion: MANAGED_SESSION_FORMAT_VERSION,
        minimumReader: MANAGED_SESSION_MINIMUM_READER,
        sessionKey: options.sessionKey,
        engine: 'managed',
        definitionRef: options.create.definitionRef,
        rootSnapshotRef: options.create.rootSnapshotRef,
        createdBy: options.create.createdBy,
      });
      // Recorded before the header, in the container's own metadata shape, so
      // every existing execution-engine guard sees a Managed session instead of
      // defaulting to legacy and letting a legacy-only operation run on it.
      if (scan.engineRecords === 0) {
        const engineUuid = randomUUID();
        await options.lease.appendJsonLine({
          uuid: engineUuid,
          parentUuid: lastRecordUuid,
          sessionId: options.sessionKey.sessionId,
          timestamp: new Date(now()).toISOString(),
          type: 'system',
          subtype: 'session_execution_engine',
          cwd: options.cwd,
          version: options.version,
          systemPayload: { version: 1, engine: 'managed' },
        });
        lastRecordUuid = engineUuid;
      }
      const uuid = randomUUID();
      await options.lease.appendJsonLine({
        uuid,
        parentUuid: lastRecordUuid,
        sessionId: options.sessionKey.sessionId,
        timestamp: new Date(now()).toISOString(),
        type: 'system',
        subtype: MANAGED_SESSION_HEADER_SUBTYPE,
        cwd: options.cwd,
        version: options.version,
        managedSession: header,
      });
      lastRecordUuid = uuid;
    }
    const authority = new LocalManagedSessionAuthority(
      options.lease,
      options.sessionKey,
      options.cwd,
      options.version,
      now,
      header,
      scan.events,
      scan.transactions,
      scan.committed,
      scan.lastMarkerDigest,
      lastRecordUuid,
      scan.activation,
      options.resources,
    );
    for (const event of scan.events) {
      authority.eventIds.add(event.eventId);
      if (event.kind === 'domain.committed') {
        authority.recordDomainEvent(event);
      }
    }
    return authority;
  }

  /**
   * Discards a tail that was appended without a commit marker, after proving
   * the retained prefix reads cleanly. Repair is explicit: opening a session
   * reports the tail and refuses to write, because a read-only owner or a
   * compatibility probe must never rewrite a transcript.
   */
  static async recoverUncommittedTail(options: {
    lease: SessionWriterLease;
    sessionKey: ManagedSessionKey;
  }): Promise<{ discardedBytes: number; diagnosticPath: string }> {
    const scan = await readManagedSessionLog(
      options.lease.transcriptPath,
      options.sessionKey,
    );
    if (scan.uncommitted === 0) {
      throw new ManagedSessionRecordError(
        'session log has no uncommitted tail to discard.',
      );
    }
    // The header has no marker after it, so a crash during the very first
    // transaction leaves committedBytes at zero. Truncating there would delete
    // the header and leave a session that can never be opened again.
    const retain = Math.max(scan.committedBytes, scan.headerBytes);
    if (retain === 0) {
      throw new ManagedSessionRecordError(
        'session log has no committed prefix to retain.',
      );
    }
    // Read as bytes: a tail torn mid-character would not survive a decode and
    // re-encode round trip.
    const bytes = await readFile(options.lease.transcriptPath);
    if (bytes.byteLength <= retain) {
      throw new ManagedSessionRecordError(
        'session log changed while preparing tail recovery.',
      );
    }
    const discarded = bytes.subarray(retain);
    const diagnosticPath = `${options.lease.transcriptPath}.uncommitted-tail`;
    const pendingPath = `${diagnosticPath}.pending`;
    await writeFile(pendingPath, discarded, { mode: 0o600 });
    try {
      await options.lease.truncateTo(retain);
    } catch (cause) {
      await unlink(pendingPath).catch(() => undefined);
      throw cause;
    }
    await rename(pendingPath, diagnosticPath);
    return { discardedBytes: discarded.byteLength, diagnosticPath };
  }

  /**
   * Bounded read of the committed prefix. It never needs a live Harness.
   */
  readEvents(
    options: { afterSequence?: number; limit?: number } = {},
  ): readonly ManagedSessionEvent[] {
    const after = options.afterSequence ?? 0;
    const limit = Math.min(
      options.limit ?? MANAGED_SESSION_LIMITS.defaultReadEvents,
      MANAGED_SESSION_LIMITS.maxReadEvents,
    );
    if (limit < 1) {
      throw new ManagedSessionRecordError('readEvents limit must be positive.');
    }
    const out: ManagedSessionEvent[] = [];
    for (const event of this.events) {
      if (event.sequence <= after) continue;
      out.push(event);
      if (out.length === limit) break;
    }
    return out;
  }

  /**
   * Persists the accepted input and the wake intent in one transaction. The
   * wake fact is generated here because an entry may request a wake but must
   * not author it.
   */
  submitInput(
    command: ManagedSessionCommand,
    input: ManagedSessionInputRequest,
  ): Promise<ManagedSessionCommitReceipt> {
    return this.runSerial(() => {
      // Read inside the lock: the committed sequence moves as other
      // transactions commit.
      const first = this.committed + 1;
      const occurredAt = this.now();
      const accepted = {
        v: MANAGED_SESSION_FORMAT_VERSION,
        sequence: first,
        eventId: `${input.inputId}:accepted`,
        sessionKey: command.sessionKey,
        kind: 'input.accepted',
        occurredAt,
        payload: {
          inputId: input.inputId,
          turnId: input.turnId,
          source: input.source,
          contentRef: input.contentRef,
          deadline: input.deadline,
          admissionRef: input.admissionRef,
        },
      };
      const wake = {
        v: MANAGED_SESSION_FORMAT_VERSION,
        sequence: first + 1,
        eventId: `${input.inputId}:wake`,
        sessionKey: command.sessionKey,
        kind: 'wake.requested',
        occurredAt,
        payload: {
          wakeId: `${input.inputId}:wake`,
          reason: input.wakeReason,
          subject: { type: 'turn', turnId: input.turnId },
          sourceEventId: `${input.inputId}:accepted`,
          requiredSequence: first,
        },
      };
      return this.commit(
        command,
        [accepted, wake],
        [{ class: 'trusted_entry' }, { class: 'authority' }],
      );
    });
  }

  /**
   * Conditional append for one actor. The events must continue the committed
   * sequence exactly.
   */
  appendExecution(
    command: ManagedSessionCommand,
    events: readonly unknown[],
    actor: ManagedSessionActor,
  ): Promise<ManagedSessionCommitReceipt> {
    return this.runSerial(() =>
      this.commit(
        command,
        events,
        events.map(() => actor),
      ),
    );
  }

  /**
   * Commits one registered domain record. The body is published as a resource
   * first, because the event carries only a reference to it; the authority
   * composes the envelope so a caller cannot choose its own revision or break
   * the per-domain chain.
   */
  async commitDomainRecord(
    command: ManagedSessionCommand,
    request: {
      domain: ManagedSessionDomain;
      content: Readonly<Record<string, unknown>>;
    },
    actor: ManagedSessionActor,
  ): Promise<ManagedSessionDomainReceipt> {
    assertManagedSessionDomainEnabled(request.domain);
    const store = this.resources;
    if (store === undefined) {
      throw new ManagedSessionRecordError(
        'a resource store is required to commit domain records.',
      );
    }
    return this.runSerial(async () => {
      const previous = this.domainRecords.get(request.domain);
      const revision = (previous?.revision ?? 0) + 1;
      const recordRef = await store.publish(
        `managed-${request.domain}`,
        Buffer.from(
          JSON.stringify({
            operationId: command.commandId,
            revision,
            previousRecordRef: previous?.recordRef ?? null,
            ...request.content,
          }),
          'utf8',
        ),
      );
      const receipt = await this.commit(
        command,
        [
          {
            v: MANAGED_SESSION_FORMAT_VERSION,
            sequence: this.committed + 1,
            eventId: `${request.domain}:${revision}`,
            sessionKey: command.sessionKey,
            kind: 'domain.committed',
            occurredAt: this.now(),
            payload: {
              domain: request.domain,
              version: MANAGED_SESSION_FORMAT_VERSION,
              operationId: command.commandId,
              recordRef,
            },
          },
        ],
        [actor],
      );
      return { receipt, recordRef, revision };
    });
  }

  /**
   * One transaction at a time. The writer lease serialises individual lines,
   * which is not enough: concurrent transactions would interleave their event
   * records around each other's commit markers.
   */
  private runSerial<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(operation, operation);
    this.queue = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  private async commit(
    command: ManagedSessionCommand,
    values: readonly unknown[],
    actors: readonly ManagedSessionActor[],
  ): Promise<ManagedSessionCommitReceipt> {
    if (this.writeFailure !== undefined) {
      throw new ManagedSessionRecordError(
        `session log writes stopped after an earlier failure: ${this.writeFailure.message}`,
      );
    }
    if (!managedSessionKeysEqual(command.sessionKey, this.sessionKey)) {
      throw new ManagedSessionConflictError(
        'command session key does not match this session.',
      );
    }
    const key = commandKey(command.operation, command.commandId);
    const previous = this.transactions.get(key);
    if (previous !== undefined) {
      if (previous.contentDigest !== command.contentDigest) {
        throw new ManagedSessionConflictError(
          `command ${command.commandId} was already committed with different content.`,
        );
      }
      return {
        ...previous.receipt,
        committedSequence: this.committed,
        replayed: true,
      };
    }
    if (
      command.expectedSequence !== undefined &&
      command.expectedSequence !== this.committed
    ) {
      throw new ManagedSessionConflictError(
        `expectedSequence ${command.expectedSequence} does not match the committed sequence ${this.committed}; re-read before retrying.`,
      );
    }

    const events = values.map((value, index) => {
      const event = parseManagedSessionEvent(value);
      const actor = actors[index];
      assertManagedSessionEventActor(event, actor.class);
      if (!managedSessionKeysEqual(event.sessionKey, this.sessionKey)) {
        throw new ManagedSessionConflictError(
          'event session key does not match this session.',
        );
      }
      this.assertActorFence(event, actor);
      if (event.kind === 'activation.changed') {
        this.assertActivationEpoch(event);
      }
      if (this.eventIds.has(event.eventId)) {
        throw new ManagedSessionConflictError(
          `event id ${event.eventId} is already committed.`,
        );
      }
      return event;
    });
    if (events.length === 0) {
      throw new ManagedSessionRecordError(
        'a transaction must contain at least one event.',
      );
    }
    if (new Set(events.map((event) => event.eventId)).size !== events.length) {
      throw new ManagedSessionConflictError(
        'a transaction must not repeat an event id.',
      );
    }
    if (events[0].sequence !== this.committed + 1) {
      throw new ManagedSessionConflictError(
        `transaction starts at sequence ${events[0].sequence} but the committed sequence is ${this.committed}.`,
      );
    }
    const encoded = events.map((event) => JSON.stringify(event));
    encoded.forEach((line, index) => {
      if (
        Buffer.byteLength(line, 'utf8') > MANAGED_SESSION_LIMITS.maxEventBytes
      ) {
        throw new ManagedSessionRecordError(
          `event ${events[index].eventId} exceeds ${MANAGED_SESSION_LIMITS.maxEventBytes} bytes.`,
        );
      }
    });
    assertManagedSessionTransaction(
      events,
      encoded.reduce((sum, line) => sum + Buffer.byteLength(line, 'utf8'), 0),
    );

    const marker = parseManagedSessionCommitMarker({
      transactionId: randomUUID(),
      commandId: command.commandId,
      operation: command.operation,
      contentDigest: command.contentDigest,
      firstSequence: events[0].sequence,
      lastSequence: events[events.length - 1].sequence,
      eventCount: events.length,
      eventsDigest: managedSessionEventsDigest(events),
      previousCommitDigest: this.lastMarkerDigest,
    });
    const markerLine = JSON.stringify(marker);
    if (
      Buffer.byteLength(markerLine, 'utf8') >
      MANAGED_SESSION_LIMITS.maxCommitMarkerBytes
    ) {
      throw new ManagedSessionRecordError(
        `commit marker exceeds ${MANAGED_SESSION_LIMITS.maxCommitMarkerBytes} bytes.`,
      );
    }

    // Events first, marker last: a crash before the marker leaves the
    // transaction invisible rather than half applied.
    try {
      for (const event of events) {
        this.lastRecordUuid = await this.appendRecord(
          MANAGED_SESSION_EVENT_SUBTYPE,
          event,
        );
      }
      this.lastRecordUuid = await this.appendRecord(
        MANAGED_SESSION_COMMIT_SUBTYPE,
        marker,
      );
    } catch (cause) {
      // Records may already be on disk, so the sequences this transaction
      // claimed are spent whether or not the marker landed.
      this.writeFailure =
        cause instanceof Error ? cause : new Error(String(cause));
      throw cause;
    }

    for (const event of events) {
      this.events.push(event);
      this.eventIds.add(event.eventId);
      if (event.kind === 'activation.changed') {
        this.activation = activationStateFrom(event);
      }
      if (event.kind === 'domain.committed') {
        this.recordDomainEvent(event);
      }
    }
    this.committed = marker.lastSequence;
    this.lastMarkerDigest = managedToolDigest(
      marker,
      MANAGED_SESSION_LIMITS.maxCommitMarkerBytes,
    );
    const receipt: ManagedSessionCommitReceipt = {
      transactionId: marker.transactionId,
      commandId: marker.commandId,
      operation: marker.operation,
      firstSequence: marker.firstSequence,
      lastSequence: marker.lastSequence,
      committedSequence: this.committed,
      replayed: false,
    };
    this.transactions.set(key, {
      receipt,
      contentDigest: command.contentDigest,
    });
    return receipt;
  }

  /**
   * The authority decides the epoch; a coordinator may only submit the value
   * the authority would assign. A new activation advances the epoch by one, and
   * a phase change keeps the epoch of the activation it describes.
   */
  private recordDomainEvent(event: ManagedSessionEvent): void {
    const domain = event.payload['domain'] as string;
    const previous = this.domainRecords.get(domain);
    this.domainRecords.set(domain, {
      revision: (previous?.revision ?? 0) + 1,
      recordRef: event.payload[
        'recordRef'
      ] as unknown as ManagedSessionDurableRef,
    });
  }

  /** The latest committed record for a registered domain, if any. */
  domainRecord(
    domain: ManagedSessionDomain,
  ): { revision: number; recordRef: ManagedSessionDurableRef } | undefined {
    return this.domainRecords.get(domain);
  }

  private assertActivationEpoch(event: ManagedSessionEvent): void {
    const next = activationStateFrom(event);
    const current = this.activation;
    if (current === undefined || next.activationId !== current.activationId) {
      const expected = (current?.epoch ?? 0) + 1;
      if (next.epoch !== expected) {
        throw new ManagedSessionConflictError(
          `activation ${next.activationId} must use epoch ${expected}, not ${next.epoch}.`,
        );
      }
      return;
    }
    if (next.epoch !== current.epoch) {
      throw new ManagedSessionConflictError(
        `activation ${next.activationId} is at epoch ${current.epoch} and cannot change to ${next.epoch}.`,
      );
    }
  }

  private assertActorFence(
    event: ManagedSessionEvent,
    actor: ManagedSessionActor,
  ): void {
    if (actor.class !== 'harness') return;
    const held = actor.activation;
    if (held === undefined) {
      throw new ManagedSessionConflictError(
        'a harness append must present the activation it holds.',
      );
    }
    const current = this.activation;
    if (current === undefined) {
      throw new ManagedSessionConflictError(
        'no activation is committed for this session, so no harness may append.',
      );
    }
    if (
      held.activationId !== current.activationId ||
      held.epoch !== current.epoch
    ) {
      throw new ManagedSessionConflictError(
        `activation ${held.activationId}/${held.epoch} is not the committed activation ${current.activationId}/${current.epoch}.`,
      );
    }
    if (current.phase !== 'installing' && current.phase !== 'active') {
      throw new ManagedSessionConflictError(
        `activation ${current.activationId} is ${current.phase} and may not append.`,
      );
    }
    const subject = event.subject;
    if (
      subject?.type !== 'activation' ||
      subject.activationId !== held.activationId ||
      subject.epoch !== held.epoch
    ) {
      throw new ManagedSessionConflictError(
        'event subject does not match the activation the harness holds.',
      );
    }
  }

  private async appendRecord(
    subtype:
      | typeof MANAGED_SESSION_EVENT_SUBTYPE
      | typeof MANAGED_SESSION_COMMIT_SUBTYPE,
    body: ManagedSessionRecordBody,
  ): Promise<string> {
    const uuid = randomUUID();
    await this.lease.appendJsonLine({
      uuid,
      parentUuid: this.lastRecordUuid,
      sessionId: this.sessionKey.sessionId,
      timestamp: new Date(this.now()).toISOString(),
      type: 'system',
      subtype,
      cwd: this.cwd,
      version: this.version,
      managedSession: body,
    });
    return uuid;
  }
}

interface ManagedSessionLogScan {
  readonly header?: ManagedSessionHeader;
  readonly events: ManagedSessionEvent[];
  readonly transactions: Map<string, CommittedTransaction>;
  readonly committed: number;
  readonly lastMarkerDigest: string | null;
  readonly lastRecordUuid: string | null;
  readonly activation: ManagedSessionActivationState | undefined;
  /** Byte length of the prefix ending at the last commit marker. */
  readonly committedBytes: number;
  /**
   * Byte length through the header. The header carries the session identity
   * and definition refs and has no marker after it, so it is a required
   * prefix rather than an uncommitted tail.
   */
  readonly headerBytes: number;
  /** Byte length of the records after it, kept for diagnostics. */
  readonly uncommittedBytes: number;
  readonly uncommitted: number;
  readonly foreignRecords: number;
  /** Engine ownership records, which a Managed log writes before its header. */
  readonly engineRecords: number;
}

/**
 * Reads the complete committed prefix. A corrupt line inside the prefix fails
 * the scan rather than being skipped, because skipping it would resume
 * execution from an incomplete state.
 */
async function readManagedSessionLog(
  path: string,
  sessionKey: ManagedSessionKey,
): Promise<ManagedSessionLogScan> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        events: [],
        transactions: new Map(),
        committed: 0,
        lastMarkerDigest: null,
        lastRecordUuid: null,
        activation: undefined,
        committedBytes: 0,
        headerBytes: 0,
        uncommittedBytes: 0,
        uncommitted: 0,
        foreignRecords: 0,
        engineRecords: 0,
      };
    }
    throw error;
  }

  const lines = text.split('\n');
  // A final line with no newline is a torn write, not a corrupt prefix.
  const tornTail = lines[lines.length - 1] !== '' ? 1 : 0;
  lines.pop();

  let header: ManagedSessionHeader | undefined;
  const events: ManagedSessionEvent[] = [];
  const transactions = new Map<string, CommittedTransaction>();
  let committed = 0;
  let lastMarkerDigest: string | null = null;
  let lastRecordUuid: string | null = null;
  let activation: ManagedSessionActivationState | undefined;
  let scanned = 0;
  let committedBytes = 0;
  let headerBytes = 0;
  let foreignRecords = 0;
  let engineRecords = 0;
  let pending: ManagedSessionEvent[] = [];

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line === '') {
      throw new ManagedSessionRecordError(
        `session log line ${index + 1} is blank.`,
      );
    }
    scanned += Buffer.byteLength(line, 'utf8') + 1;
    const record = parseManagedSessionRecordJson(
      line,
      MANAGED_SESSION_LIMITS.maxEventBytes,
    );
    if (
      record === null ||
      typeof record !== 'object' ||
      Array.isArray(record)
    ) {
      throw new ManagedSessionRecordError(
        `session log line ${index + 1} is not a record object.`,
      );
    }
    const envelope = record as Record<string, unknown>;
    const subtype = envelope['subtype'];
    if (typeof envelope['uuid'] === 'string') {
      lastRecordUuid = envelope['uuid'];
    }
    if (
      subtype !== MANAGED_SESSION_HEADER_SUBTYPE &&
      subtype !== MANAGED_SESSION_EVENT_SUBTYPE &&
      subtype !== MANAGED_SESSION_COMMIT_SUBTYPE
    ) {
      if (header !== undefined) {
        throw new ManagedSessionRecordError(
          `session log line ${index + 1} has the unknown subtype ${String(subtype)} after the Managed header.`,
        );
      }
      foreignRecords++;
      if (subtype === 'session_execution_engine') engineRecords++;
      continue;
    }
    const body = envelope['managedSession'];
    if (subtype === MANAGED_SESSION_HEADER_SUBTYPE) {
      if (header !== undefined) {
        throw new ManagedSessionRecordError(
          `session log line ${index + 1} repeats the Managed header.`,
        );
      }
      header = parseManagedSessionHeader(body);
      headerBytes = scanned;
      if (!managedSessionKeysEqual(header.sessionKey, sessionKey)) {
        throw new ManagedSessionRecordError(
          'session log header belongs to a different session.',
        );
      }
      continue;
    }
    if (header === undefined) {
      throw new ManagedSessionRecordError(
        `session log line ${index + 1} precedes the Managed header.`,
      );
    }
    if (subtype === MANAGED_SESSION_EVENT_SUBTYPE) {
      const event = parseManagedSessionEvent(body);
      if (!managedSessionKeysEqual(event.sessionKey, sessionKey)) {
        throw new ManagedSessionRecordError(
          `session log line ${index + 1} belongs to a different session.`,
        );
      }
      const expected = committed + pending.length + 1;
      if (event.sequence !== expected) {
        throw new ManagedSessionRecordError(
          `session log line ${index + 1} has sequence ${event.sequence} where ${expected} was expected.`,
        );
      }
      pending.push(event);
      continue;
    }
    const marker = parseManagedSessionCommitMarker(body);
    if (marker.previousCommitDigest !== lastMarkerDigest) {
      throw new ManagedSessionRecordError(
        `session log line ${index + 1} does not chain to the previous commit.`,
      );
    }
    if (
      marker.eventCount !== pending.length ||
      marker.firstSequence !== committed + 1 ||
      marker.lastSequence !== committed + pending.length
    ) {
      throw new ManagedSessionRecordError(
        `session log line ${index + 1} does not cover the preceding events.`,
      );
    }
    if (marker.eventsDigest !== managedSessionEventsDigest(pending)) {
      throw new ManagedSessionRecordError(
        `session log line ${index + 1} does not match the preceding event content.`,
      );
    }
    for (const event of pending) {
      events.push(event);
      if (event.kind === 'activation.changed') {
        activation = activationStateFrom(event);
      }
    }
    committed = marker.lastSequence;
    committedBytes = scanned;
    lastMarkerDigest = managedToolDigest(
      marker,
      MANAGED_SESSION_LIMITS.maxCommitMarkerBytes,
    );
    transactions.set(commandKey(marker.operation, marker.commandId), {
      contentDigest: marker.contentDigest,
      receipt: {
        transactionId: marker.transactionId,
        commandId: marker.commandId,
        operation: marker.operation,
        firstSequence: marker.firstSequence,
        lastSequence: marker.lastSequence,
        committedSequence: marker.lastSequence,
        replayed: false,
      },
    });
    pending = [];
  }

  return {
    header,
    events,
    transactions,
    committed,
    lastMarkerDigest,
    lastRecordUuid,
    activation,
    committedBytes,
    headerBytes,
    uncommittedBytes: Buffer.byteLength(text, 'utf8') - committedBytes,
    uncommitted: pending.length + tornTail,
    foreignRecords,
    engineRecords,
  };
}

function activationStateFrom(
  event: ManagedSessionEvent,
): ManagedSessionActivationState {
  return {
    activationId: event.payload['activationId'] as string,
    epoch: event.payload['epoch'] as number,
    phase: event.payload['phase'] as string,
  };
}
