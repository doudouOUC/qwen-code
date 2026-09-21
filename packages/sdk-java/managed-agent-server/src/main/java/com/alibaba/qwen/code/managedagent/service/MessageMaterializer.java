package com.alibaba.qwen.code.managedagent.service;

import com.alibaba.qwen.code.managedagent.store.AgentStateStore;
import com.alibaba.qwen.code.managedagent.store.StoreModels.DeliveryClaim;
import java.time.Duration;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

@Component
public class MessageMaterializer {
    private static final Logger LOG = LoggerFactory.getLogger(
            MessageMaterializer.class);
    private static final int TARGET_LIMIT = 32;
    private static final Duration CLAIM_LEASE = Duration.ofSeconds(30);
    private static final Duration RETRY_DELAY = Duration.ofSeconds(1);
    private final AgentStateStore store;
    private final String owner = "materializer-" + UUID.randomUUID();

    public MessageMaterializer(AgentStateStore store) {
        this.store = store;
    }

    @Scheduled(fixedDelayString =
            "${qwen.managed-agent.events.materialize-interval:100ms}")
    public void materialize() {
        for (DeliveryClaim claim : store.claimDeliveries(
                AgentStateStore.MESSAGE_PROJECTION, owner, CLAIM_LEASE,
                TARGET_LIMIT)) {
            try {
                store.materializeDelivery(claim);
            } catch (RuntimeException error) {
                LOG.warn("Failed to materialize Managed Agent session {}",
                        claim.sessionId(), error);
                store.retryDelivery(claim, RETRY_DELAY,
                        error.getClass().getSimpleName());
            }
        }
    }
}
