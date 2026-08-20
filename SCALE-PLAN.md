# TrackFlow Scale Plan

## Partitioning Strategy

The `events` table is the dominant growth surface: it receives about 10 million rows per day and approximately 300 million rows per 30-day month. It is now a PostgreSQL `RANGE`-partitioned table on `created_at`, with monthly partitions named `events_YYYY_MM` and a `events_default` safety partition.

Monthly range partitions are the right granularity for this workload. Daily partitions would create too many relations and increase planning and operational overhead at the projected scale, while yearly partitions would make retention and recent-window pruning too coarse. The partition key is part of the primary key because PostgreSQL requires a partitioned table's unique constraint to include the partitioning column.

The migration approach for an existing production table is to create the new partitioned structure alongside the current table, backfill in bounded time ranges, compare counts and checksums, then cut over ingestion during a short maintenance window or use a dual-write period. Future partitions should be created before the month starts. The default partition is a safety net, not a substitute for partition maintenance; a scheduled check should alert if it contains rows.

The local index `idx_events_user_created_at` supports the activity feed query by matching its `user_id` equality predicate, descending timestamp order, and `LIMIT 100`. `idx_events_created_type` supports recent-window analytics and gives the planner a useful path on the time predicate and event type.

### Affected routes

| Route | Effect of partitioning |
|---|---|
| `POST /events` | Inserts are routed automatically to the partition for `created_at`; the default partition prevents an out-of-range insert from failing during maintenance gaps. |
| `GET /events?user_id=...` | Uses the composite user/timestamp index on the partitions. It returns the same recent activity shape while avoiding a broad table scan. |
| `GET /metrics/monthly` | The 30-day `created_at` predicate allows PostgreSQL to prune partitions outside the reporting window. |
| `POST /metrics/feature-usage` | Unchanged; feature usage is not part of the event retention path. |
| Session routes | Unchanged by event partitioning, but active-session monitoring gains its own partial index. |

## Archive Strategy

Cold event data is stored in `events_archive`, which preserves the event payload and logical `(id, created_at)` key while adding `archived_at`. The archive has independent indexes for user history and timestamp-based retrieval. The `archive_events_before(cutoff)` function provides a deterministic SQL entry point for a retention job.

For large production tables, archiving should operate on complete old monthly partitions whenever possible: detach an old partition from `events`, attach or copy it into the archive tier, validate row counts, and then drop or move the archived relation according to the retention policy. The supplied function is intentionally simple and transaction-safe for the assignment and small migrations; a production implementation should process large ranges in batches to limit WAL bursts and lock duration.

The hot `events` table should retain only the period needed for product dashboards and operational support. Older data remains available in the archive for compliance and historical investigations, but it is no longer part of the default hot-path queries. If the product later needs all-time user history, the API should expose an explicit archive query rather than silently joining hot and cold stores on every request.

### Affected routes

| Route | Effect of archiving |
|---|---|
| `GET /events?user_id=...` | Continues to serve recent activity from hot partitions. It intentionally does not pay archive latency for a dashboard's recent feed. |
| `GET /metrics/monthly` | The 30-day window remains on the hot path; older reporting should use a separate archive/rollup query. |
| `POST /events` | Continues to write only to the primary hot table. |
| Retention job | Calls `archive_events_before` or performs partition detach-and-archive operations outside request handling. |

## Read-Replica Strategy

The application now creates a primary pool and a replica pool. `PRIMARY_DB_URL` is used for writes; `REPLICA_DB_URL` is used for dashboard and monitoring reads. For local testing, omitting `REPLICA_DB_URL` falls back to the primary connection, so a single PostgreSQL instance works without changing route behavior. The legacy `DATABASE_URL` remains supported as the primary fallback.

The following routes use the replica: `GET /events`, `GET /sessions/active`, and `GET /metrics/monthly`. The following routes remain on the primary: `POST /events`, `POST /sessions/start`, and `POST /metrics/feature-usage`. This separation prevents expensive dashboard aggregation and monitoring queries from consuming the same primary connection pool as ingestion.

Replica reads are eventually consistent. A user may create an event or session and briefly fail to see it in a subsequent dashboard read if replication has not caught up. The API therefore does not route read-after-write-sensitive responses to the replica. If a workflow requires monotonic reads, it should use a short-lived primary read token, wait for a replica LSN/lag threshold, or explicitly query the primary.

Connection pool sizes are configurable using `DB_POOL_MAX`, `DB_IDLE_TIMEOUT_MS`, and `DB_CONNECTION_TIMEOUT_MS`. In production, the replica pool should have an independent capacity budget and health checks; the application should also implement circuit-breaking or a controlled fallback to primary if the replica is unavailable.

## Implementation Order

1. **Partitioning first.** The unbounded event heap is the most urgent risk because storage, vacuum, backups, and all event reads deteriorate as 10 million rows arrive daily. Partitioning supplies the time boundary required by both efficient recent queries and safe retention.
2. **Archiving second.** Once data is organized by time, cold partitions can be moved out of the hot working set. This reduces active-table size and turns retention into a bounded, repeatable operation.
3. **Read replicas third.** Read isolation should follow physical-layout improvements. Otherwise, the replica would simply reproduce expensive scans and aggregation work on a second database.

## Trade-offs and Risks

| Strategy | Trade-off / failure mode | Mitigation |
|---|---|---|
| Partitioning | Partition management adds operational complexity. Missing a future partition can send rows to the default partition, and too many small partitions can increase planning overhead. | Pre-create partitions, alert on default-partition rows, keep monthly granularity, and test inserts at month boundaries. |
| Archiving | Archive queries may be slower or stale relative to the hot store, and a large copy/delete can generate substantial WAL and lock contention. | Prefer detach-and-archive for complete partitions, run bounded batches, validate counts before removal, and expose archive access explicitly. |
| Read replicas | Replication lag can make newly written events temporarily invisible, while a replica outage can break read endpoints if there is no fallback. | Keep writes on primary, document eventual consistency, monitor lag, configure a safe primary fallback for local or degraded operation, and use a circuit breaker in production. |

## Validation Checklist

- `GROWTH-ANALYSIS.md` is committed before the schema and application changes.
- `schema.sql` creates a partitioned `events` table, monthly partitions, a default partition, archive storage, and required indexes.
- `archive_events_before` moves rows older than a supplied cutoff into `events_archive`.
- Write routes use the primary pool and read routes use the replica pool.
- If `REPLICA_DB_URL` equals `PRIMARY_DB_URL`, all endpoints remain testable on one database.
- The README includes the deployment URL after deployment and documents both database URL variables.
