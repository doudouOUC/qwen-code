package com.alibaba.qwen.code.managedagent;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.alibaba.qwen.code.managedagent.store.AgentStateStore;
import com.alibaba.qwen.code.managedagent.store.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.store.StoreModels.Admission;
import com.alibaba.qwen.code.managedagent.store.StoreModels.DeliveryClaim;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.SQLException;
import java.time.Clock;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.MigrationVersion;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.transaction.support.TransactionTemplate;

class ManagedAgentMySqlIT {
    @Test
    void materializesReplayableItemsAndSnapshotsOnMySql()
            throws SQLException {
        DriverManagerDataSource dataSource = new DriverManagerDataSource(
                required("mysql.url"), required("mysql.user"),
                System.getProperty("mysql.password", ""));
        Flyway.configure().dataSource(dataSource)
                .locations("classpath:db/migration")
                .target(MigrationVersion.fromVersion("1")).load().migrate();
        JdbcTemplate jdbc = new JdbcTemplate(dataSource);
        jdbc.update("INSERT INTO managed_agent_session (tenant_id,"
                        + " session_id, agent_id, status, created_at,"
                        + " updated_at, last_sequence) VALUES"
                        + " (?, ?, ?, ?, ?, ?, ?)",
                "mysql-upgrade", "session_upgrade", "qwen-code", "IDLE",
                1L, 1L, 1L);
        jdbc.update("INSERT INTO managed_agent_event (tenant_id, session_id,"
                        + " sequence_id, event_id, event_type, data_json,"
                        + " terminal, created_at) VALUES"
                        + " (?, ?, ?, ?, ?, ?, ?, ?)",
                "mysql-upgrade", "session_upgrade", 1L, "upgrade-event",
                "session.created", "{}", false, 1L);
        Flyway.configure().dataSource(dataSource)
                .locations("classpath:db/migration").load().migrate();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM"
                        + " managed_agent_consumer_progress WHERE tenant_id = ?"
                        + " AND session_id = ? AND consumer_name = ?",
                Integer.class, "mysql-upgrade", "session_upgrade",
                "message_projection")).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM"
                        + " managed_agent_event_batch WHERE tenant_id = ?"
                        + " AND session_id = ?", Integer.class,
                "mysql-upgrade", "session_upgrade")).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM"
                        + " managed_agent_batch_delivery WHERE tenant_id = ?"
                        + " AND session_id = ?", Integer.class,
                "mysql-upgrade", "session_upgrade")).isEqualTo(1);
        ManagedAgentStore store = new ManagedAgentStore(
                jdbc, new ObjectMapper(), Clock.systemUTC(), ignored -> {
                });
        TransactionTemplate transaction = new TransactionTemplate(
                new DataSourceTransactionManager(dataSource));
        String tenant = "mysql-projection";
        List<Map<String, Object>> input = List.of(Map.of(
                "type", "text", "text", "hello"));
        Admission admission = store.insertSessionCommand(tenant,
                "CREATE_SESSION", "mysql-create",
                "sha256:" + "a".repeat(64), "qwen-code", null, input,
                "sha256:" + "b".repeat(64));
        String assistantItem = "item_" + admission.turnId() + "_assistant";
        String part = "part_" + admission.turnId() + "_output_text";
        store.appendPublicEventIfAbsent(tenant, admission.sessionId(),
                admission.turnId(), "item.output_text.delta", Map.of(
                        "itemId", assistantItem, "contentPartId", part,
                        "text", "hel"), false, "mysql:1");
        store.appendPublicEventIfAbsent(tenant, admission.sessionId(),
                admission.turnId(), "item.output_text.delta", Map.of(
                        "itemId", assistantItem, "contentPartId", part,
                        "text", "lo"), false, "mysql:2");
        store.appendPublicEventIfAbsent(tenant, admission.sessionId(),
                admission.turnId(), "item.tool_call.updated", Map.of(
                        "toolCallId", "legacy-tool", "name", "read_file",
                        "status", "completed"), false, "mysql:legacy-tool");
        store.appendPublicEventIfAbsent(tenant, admission.sessionId(),
                admission.turnId(), "turn.completed", Map.of(), true,
                "mysql:3");

        materializeAll(store, transaction, "mysql-materializer");
        assertThat(store.findSnapshot(tenant, admission.sessionId()))
                .get().satisfies(snapshot -> {
                    assertThat(snapshot.coveredSequence()).isEqualTo(6);
                    assertThat(snapshot.items()).hasSize(3)
                            .filteredOn(item ->
                                    "assistant".equals(item.role()))
                            .filteredOn(item -> "message".equals(item.type()))
                            .singleElement().satisfies(item -> {
                                assertThat(item.status())
                                        .isEqualTo("completed");
                                assertThat(item.content()).singleElement()
                                        .extracting(content -> content.text())
                                        .isEqualTo("hello");
                            });
                    assertThat(snapshot.items())
                            .filteredOn(item -> "tool_call".equals(item.type()))
                            .singleElement().satisfies(item -> {
                                assertThat(item.status())
                                        .isEqualTo("completed");
                                assertThat(item.attributes())
                                        .containsEntry("toolCallId",
                                                "legacy-tool");
                            });
                });
        List<DeliveryClaim> remaining = transaction.execute(ignored ->
                store.claimDeliveries(AgentStateStore.MESSAGE_PROJECTION,
                        "mysql-materializer", Duration.ofMinutes(1), 1));
        assertThat(remaining).isEmpty();

        verifiesClaimGenerationFencing(store, jdbc, transaction);
        verifiesLateCommitIsStillClaimed(store, dataSource, jdbc,
                transaction);
    }

    private static void verifiesClaimGenerationFencing(
            ManagedAgentStore store, JdbcTemplate jdbc,
            TransactionTemplate transaction) {
        Admission admission = transaction.execute(ignored ->
                store.insertSessionCommand("mysql-fencing",
                        "CREATE_SESSION", "fencing-create",
                        "sha256:" + "c".repeat(64), "qwen-code", null,
                        List.of(), null));
        DeliveryClaim first = claim(store, transaction, "worker-one");
        jdbc.update("UPDATE managed_agent_batch_delivery SET lease_until = 0"
                        + " WHERE tenant_id = ? AND session_id = ?",
                "mysql-fencing", admission.sessionId());
        DeliveryClaim second = claim(store, transaction, "worker-two");
        assertThat(second.claimGeneration())
                .isEqualTo(first.claimGeneration() + 1);

        assertThatThrownBy(() -> transaction.execute(ignored ->
                store.materializeDelivery(first)))
                .isInstanceOf(IllegalStateException.class)
                .hasMessage("Delivery claim was lost");
        assertThat(jdbc.queryForMap("SELECT state, lease_owner,"
                        + " claim_generation FROM"
                        + " managed_agent_batch_delivery WHERE tenant_id = ?"
                        + " AND session_id = ?", "mysql-fencing",
                admission.sessionId()))
                .containsEntry("state", "LEASED")
                .containsEntry("lease_owner", "worker-two")
                .containsEntry("claim_generation",
                        second.claimGeneration());
        assertThat(transaction.execute(ignored ->
                store.materializeDelivery(second)).advanced()).isTrue();
    }

    private static void verifiesLateCommitIsStillClaimed(
            ManagedAgentStore store, DriverManagerDataSource dataSource,
            JdbcTemplate jdbc, TransactionTemplate transaction)
            throws SQLException {
        Admission firstSession = transaction.execute(ignored ->
                store.insertSessionCommand("mysql-late-commit",
                        "CREATE_SESSION", "first-create",
                        "sha256:" + "d".repeat(64), "qwen-code", null,
                        List.of(), null));
        Admission secondSession = transaction.execute(ignored ->
                store.insertSessionCommand("mysql-late-commit",
                        "CREATE_SESSION", "second-create",
                        "sha256:" + "e".repeat(64), "qwen-code", null,
                        List.of(), null));
        materializeAll(store, transaction, "late-commit-setup");

        try (Connection first = dataSource.getConnection();
                Connection second = dataSource.getConnection()) {
            first.setAutoCommit(false);
            second.setAutoCommit(false);
            insertSyntheticDelivery(first, firstSession.sessionId(),
                    "batch-first");
            insertSyntheticDelivery(second, secondSession.sessionId(),
                    "batch-second");
            second.commit();

            DeliveryClaim committed = claim(store, transaction,
                    "late-commit-worker");
            assertThat(committed.batchId()).isEqualTo("batch-second");
            assertThat(transaction.execute(ignored ->
                    store.materializeDelivery(committed)).advanced()).isTrue();

            first.commit();
            DeliveryClaim late = claim(store, transaction,
                    "late-commit-worker");
            assertThat(late.batchId()).isEqualTo("batch-first");
            assertThat(transaction.execute(ignored ->
                    store.materializeDelivery(late)).advanced()).isTrue();
            Long firstOffset = jdbc.queryForObject("SELECT batch_offset FROM"
                            + " managed_agent_event_batch WHERE batch_id = ?",
                    Long.class, "batch-first");
            Long secondOffset = jdbc.queryForObject("SELECT batch_offset FROM"
                            + " managed_agent_event_batch WHERE batch_id = ?",
                    Long.class, "batch-second");
            assertThat(firstOffset).isLessThan(secondOffset);
        }
    }

    private static void insertSyntheticDelivery(Connection connection,
            String sessionId, String batchId) throws SQLException {
        long now = Clock.systemUTC().millis();
        try (PreparedStatement session = connection.prepareStatement(
                "UPDATE managed_agent_session SET last_sequence = 2,"
                        + " updated_at = ? WHERE tenant_id = ? AND"
                        + " session_id = ?")) {
            session.setLong(1, now);
            session.setString(2, "mysql-late-commit");
            session.setString(3, sessionId);
            session.executeUpdate();
        }
        try (PreparedStatement event = connection.prepareStatement(
                "INSERT INTO managed_agent_event (tenant_id, session_id,"
                        + " sequence_id, event_id, event_type, data_json,"
                        + " terminal, source_key, created_at) VALUES"
                        + " (?, ?, 2, ?, 'session.updated', '{}', FALSE,"
                        + " ?, ?)")) {
            event.setString(1, "mysql-late-commit");
            event.setString(2, sessionId);
            event.setString(3, "event-" + batchId);
            event.setString(4, "source-" + batchId);
            event.setLong(5, now);
            event.executeUpdate();
        }
        try (PreparedStatement batch = connection.prepareStatement(
                "INSERT INTO managed_agent_event_batch (tenant_id,"
                        + " session_id, batch_id, producer_kind,"
                        + " first_sequence, last_sequence, event_count,"
                        + " terminal, accepted_at, expires_at) VALUES"
                        + " (?, ?, ?, 'test', 2, 2, 1, FALSE, ?, ?)")) {
            batch.setString(1, "mysql-late-commit");
            batch.setString(2, sessionId);
            batch.setString(3, batchId);
            batch.setLong(4, now);
            batch.setLong(5, now + Duration.ofHours(1).toMillis());
            batch.executeUpdate();
        }
        try (PreparedStatement delivery = connection.prepareStatement(
                "INSERT INTO managed_agent_batch_delivery (tenant_id,"
                        + " session_id, batch_id, consumer_name,"
                        + " available_at) VALUES (?, ?, ?, ?, ?)")) {
            delivery.setString(1, "mysql-late-commit");
            delivery.setString(2, sessionId);
            delivery.setString(3, batchId);
            delivery.setString(4, AgentStateStore.MESSAGE_PROJECTION);
            delivery.setLong(5, now);
            delivery.executeUpdate();
        }
    }

    private static DeliveryClaim claim(ManagedAgentStore store,
            TransactionTemplate transaction, String owner) {
        List<DeliveryClaim> claims = transaction.execute(ignored ->
                store.claimDeliveries(AgentStateStore.MESSAGE_PROJECTION,
                        owner, Duration.ofMinutes(1), 1));
        assertThat(claims).hasSize(1);
        return claims.get(0);
    }

    private static void materializeAll(ManagedAgentStore store,
            TransactionTemplate transaction, String owner) {
        while (true) {
            List<DeliveryClaim> claims = transaction.execute(ignored ->
                    store.claimDeliveries(
                            AgentStateStore.MESSAGE_PROJECTION, owner,
                            Duration.ofMinutes(1), 32));
            if (claims.isEmpty()) {
                return;
            }
            for (DeliveryClaim claim : claims) {
                transaction.execute(ignored ->
                        store.materializeDelivery(claim));
            }
        }
    }

    private static String required(String name) {
        String value = System.getProperty(name);
        if (value == null || value.isBlank()) {
            throw new IllegalStateException(name + " is required");
        }
        return value;
    }
}
