CREATE TABLE managed_agent_event_batch (
    batch_offset BIGINT NOT NULL AUTO_INCREMENT,
    tenant_id VARCHAR(128) NOT NULL,
    session_id VARCHAR(64) NOT NULL,
    batch_id VARCHAR(64) NOT NULL,
    turn_id VARCHAR(64),
    producer_kind VARCHAR(16) NOT NULL,
    source_event_epoch VARCHAR(64),
    source_first_event_id BIGINT,
    source_last_event_id BIGINT,
    first_sequence BIGINT NOT NULL,
    last_sequence BIGINT NOT NULL,
    event_count INT NOT NULL,
    payload_json LONGTEXT,
    payload_sha256 CHAR(64),
    terminal BOOLEAN NOT NULL DEFAULT FALSE,
    accepted_at BIGINT NOT NULL,
    expires_at BIGINT NOT NULL,
    PRIMARY KEY (batch_offset),
    UNIQUE (tenant_id, session_id, batch_id),
    FOREIGN KEY (tenant_id, session_id)
        REFERENCES managed_agent_session (tenant_id, session_id),
    CHECK (first_sequence > 0),
    CHECK (last_sequence >= first_sequence),
    CHECK (event_count = last_sequence - first_sequence + 1)
);

CREATE INDEX managed_agent_event_batch_replay_idx
    ON managed_agent_event_batch
        (tenant_id, session_id, first_sequence, last_sequence);

CREATE TABLE managed_agent_batch_delivery (
    tenant_id VARCHAR(128) NOT NULL,
    session_id VARCHAR(64) NOT NULL,
    batch_id VARCHAR(64) NOT NULL,
    consumer_name VARCHAR(64) NOT NULL,
    state VARCHAR(16) NOT NULL DEFAULT 'PENDING',
    available_at BIGINT NOT NULL,
    lease_owner VARCHAR(128),
    lease_until BIGINT,
    claim_generation BIGINT NOT NULL DEFAULT 0,
    attempts INT NOT NULL DEFAULT 0,
    last_error_code VARCHAR(128),
    completed_at BIGINT,
    PRIMARY KEY (tenant_id, session_id, batch_id, consumer_name),
    FOREIGN KEY (tenant_id, session_id, batch_id)
        REFERENCES managed_agent_event_batch
            (tenant_id, session_id, batch_id),
    CHECK (state IN ('PENDING', 'LEASED', 'DONE', 'BLOCKED')),
    CHECK (claim_generation >= 0),
    CHECK (attempts >= 0)
);

CREATE INDEX managed_agent_batch_delivery_pending_idx
    ON managed_agent_batch_delivery
        (consumer_name, state, available_at);

CREATE INDEX managed_agent_batch_delivery_expired_idx
    ON managed_agent_batch_delivery
        (consumer_name, state, lease_until);

INSERT INTO managed_agent_event_batch (
    tenant_id, session_id, batch_id, producer_kind,
    first_sequence, last_sequence, event_count, terminal,
    accepted_at, expires_at
)
SELECT e.tenant_id, e.session_id,
       CONCAT('backfill:', MIN(e.sequence_id), ':', MAX(e.sequence_id)),
       'legacy', MIN(e.sequence_id), MAX(e.sequence_id), COUNT(*),
       MAX(CASE WHEN e.terminal THEN 1 ELSE 0 END),
       MIN(e.created_at), 9223372036854775807
FROM managed_agent_event e
JOIN managed_agent_consumer_progress p
  ON p.tenant_id = e.tenant_id
 AND p.session_id = e.session_id
 AND p.consumer_name = 'message_projection'
WHERE e.sequence_id > p.covered_sequence
GROUP BY e.tenant_id, e.session_id,
         FLOOR((e.sequence_id - 1) / 100);

INSERT INTO managed_agent_batch_delivery (
    tenant_id, session_id, batch_id, consumer_name, available_at
)
SELECT tenant_id, session_id, batch_id, 'message_projection', 0
FROM managed_agent_event_batch;
