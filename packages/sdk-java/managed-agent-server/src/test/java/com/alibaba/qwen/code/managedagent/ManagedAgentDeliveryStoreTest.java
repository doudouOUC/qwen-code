package com.alibaba.qwen.code.managedagent;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.alibaba.qwen.code.managedagent.store.AgentStateStore;
import com.alibaba.qwen.code.managedagent.store.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.store.StoreModels.Admission;
import com.alibaba.qwen.code.managedagent.store.StoreModels.DeliveryClaim;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Clock;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.transaction.support.TransactionTemplate;

class ManagedAgentDeliveryStoreTest {
    private JdbcTemplate jdbc;
    private ManagedAgentStore store;
    private TransactionTemplate transaction;

    @BeforeEach
    void setUp() {
        DriverManagerDataSource dataSource = new DriverManagerDataSource(
                "jdbc:h2:mem:delivery-" + UUID.randomUUID()
                        + ";MODE=MySQL;DB_CLOSE_DELAY=-1;"
                        + "DATABASE_TO_LOWER=TRUE",
                "sa", "");
        Flyway.configure().dataSource(dataSource)
                .locations("classpath:db/migration").load().migrate();
        jdbc = new JdbcTemplate(dataSource);
        store = new ManagedAgentStore(jdbc, new ObjectMapper(),
                Clock.systemUTC(), ignored -> {
                });
        transaction = new TransactionTemplate(
                new DataSourceTransactionManager(dataSource));
    }

    @Test
    void rejectsStaleClaimAfterExpiredLeaseIsReclaimed() {
        Admission admission = transaction.execute(ignored ->
                store.insertSessionCommand("tenant", "CREATE_SESSION",
                        "create", "sha256:" + "a".repeat(64), "qwen-code",
                        null, List.of(), null));
        DeliveryClaim first = claim("worker-one");
        jdbc.update("UPDATE managed_agent_batch_delivery SET lease_until = 0"
                        + " WHERE tenant_id = ? AND session_id = ?",
                "tenant", admission.sessionId());
        assertThat(store.retryDelivery(first, Duration.ZERO, "failed"))
                .isFalse();

        DeliveryClaim second = claim("worker-two");
        assertThat(second.claimGeneration())
                .isEqualTo(first.claimGeneration() + 1);

        assertThatThrownBy(() -> transaction.execute(ignored ->
                store.materializeDelivery(first)))
                .isInstanceOf(IllegalStateException.class)
                .hasMessage("Delivery claim was lost");
        assertThat(jdbc.queryForMap("SELECT state, lease_owner,"
                        + " claim_generation FROM"
                        + " managed_agent_batch_delivery WHERE tenant_id = ?"
                        + " AND session_id = ?", "tenant",
                admission.sessionId()))
                .containsEntry("state", "LEASED")
                .containsEntry("lease_owner", "worker-two")
                .containsEntry("claim_generation",
                        second.claimGeneration());

        assertThat(transaction.execute(ignored ->
                store.materializeDelivery(second)).advanced()).isTrue();
        assertThat(jdbc.queryForObject("SELECT state FROM"
                        + " managed_agent_batch_delivery WHERE tenant_id = ?"
                        + " AND session_id = ?", String.class, "tenant",
                admission.sessionId())).isEqualTo("DONE");
        assertThatThrownBy(() -> transaction.execute(ignored ->
                store.materializeDelivery(second)))
                .isInstanceOf(IllegalStateException.class)
                .hasMessage("Delivery claim was lost");
    }

    @Test
    void claimsOnlyTheFirstUnfinishedBatchForEachSession() {
        Admission admission = transaction.execute(ignored ->
                store.insertSessionCommand("tenant", "CREATE_SESSION",
                        "create", "sha256:" + "a".repeat(64), "qwen-code",
                        null, List.of(), null));
        transaction.executeWithoutResult(ignored ->
                store.appendPublicEventIfAbsent("tenant",
                        admission.sessionId(), null, "session.updated",
                        Map.of(), false, "second"));

        DeliveryClaim first = claim("worker-one");
        assertThat(first.firstSequence()).isEqualTo(1);
        List<DeliveryClaim> blocked = transaction.execute(ignored ->
                store.claimDeliveries(
                        AgentStateStore.MESSAGE_PROJECTION, "worker-two",
                        Duration.ofMinutes(1), 32));
        assertThat(blocked).isEmpty();

        transaction.execute(ignored -> store.materializeDelivery(first));
        DeliveryClaim second = claim("worker-two");
        assertThat(second.firstSequence()).isEqualTo(2);
        assertThat(transaction.execute(ignored ->
                store.materializeDelivery(second)).coveredSequence())
                .isEqualTo(2);
    }

    private DeliveryClaim claim(String owner) {
        List<DeliveryClaim> claims = transaction.execute(ignored ->
                store.claimDeliveries(AgentStateStore.MESSAGE_PROJECTION,
                        owner, Duration.ofMinutes(1), 1));
        assertThat(claims).hasSize(1);
        return claims.get(0);
    }
}
