# Qwen Managed Runtime Broker State

This Java 21 module defines the durable state boundary for a future Managed
Agent Runtime Broker. It contains Runtime binding, Runtime Session, and Tool
execution records; repository contracts; thread-safe in-memory reference
implementations; and JDBC implementations coordinated through a shared
database.

`JdbcRuntimeBrokerSchema.initialize(DataSource)` installs the private Broker
tables. The JDBC implementations use only `javax.sql.DataSource`; the embedding
service owns the connection pool and schema lifecycle. This module intentionally
does not provision Runtime processes, expose an HTTP API, call the Hosted
Harness, or wire a Spring service. Those integrations belong to later PRs.

Building and running this module requires JDK 21 or later. Its Maven release
target is 21; services embedding the resulting JAR must also use JDK 21 or later.

Build and test with:

```bash
mvn test
mvn checkstyle:check
```

Run the optional real-MySQL contract with:

```bash
mvn -Pmysql-integration \
  -Dmysql.url='jdbc:mysql://127.0.0.1:3306/runtime_broker_test' \
  -Dmysql.user=root \
  -Dmysql.password= \
  verify
```

Durable rows alone do not make a stopped local Runtime process recoverable.
The embedding service must reconcile a persisted lease before reuse and own the
process adoption or reprovisioning policy.
