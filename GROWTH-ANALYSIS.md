# TrackFlow Growth Analysis

## Scope and current workload

TrackFlow currently serves **50,000 active users** and records an average of **200 events per user per day**. The expected ingestion rate is therefore:

```text
50,000 users × 200 events/user/day = 10,000,000 event rows/day
```

The current `events` table contains approximately **45,000,000 rows**, which represents:

```text
45,000,000 rows ÷ 10,000,000 rows/day = 4.5 days of event data
```

The supplied growth scenario projects **300,000,000 event rows per month**. This is consistent with the daily rate using a 30-day planning month:

```text
10,000,000 rows/day × 30 days = 300,000,000 rows/month
```

This analysis treats the event stream as the dominant workload. The `users` table grows with customer acquisition and is comparatively small; `sessions` and `feature_usage` are modeled using conservative operational assumptions because the starter schema does not provide historical row counts.

## Row-count projections

| Table | Current / baseline estimate | 10× scale | 100× scale | 1,000× scale | Projection basis |
|---|---:|---:|---:|---:|---|
| `events` | 45,000,000 rows | 450,000,000 | 4,500,000,000 | 45,000,000,000 | Current supplied count multiplied by scale factor |
| `sessions` | 1,500,000 rows/month | 15,000,000 | 150,000,000 | 1,500,000,000 | 1 session/user/day × 50,000 users × 30 days |
| `feature_usage` | 1,500,000 rows/month | 15,000,000 | 150,000,000 | 1,500,000,000 | 1 feature interaction/user/day × 50,000 users × 30 days |
| `users` | 50,000 rows | 500,000 | 5,000,000 | 50,000,000 | One row per active user |

The event table reaches the most urgent operational threshold first. At the current rate, one month adds 300 million rows; a year adds approximately **3.65 billion rows**:

```text
300,000,000 rows/month × 12 months = 3,600,000,000 rows/year
10,000,000 rows/day × 365 days = 3,650,000,000 rows/year
```

At 10× the current table size, the event table is 450 million rows, or approximately 45 days of ingestion at the current daily rate. At 100×, it is 4.5 billion rows, and at 1,000× it is 45 billion rows. These volumes make a single heap increasingly expensive to scan, vacuum, back up, and maintain, even when the application only needs a recent time window.

## Current query and write-path review

The current code has one write path for each mutable workload and four read paths with different scale characteristics:

| Route | Query shape | Primary scale concern | Recommended database |
|---|---|---|---|
| `POST /events` | Inserts one row and returns it | Sustained write volume and index/write amplification | Primary |
| `GET /events?user_id=...` | Filters by user, sorts by `created_at DESC`, returns 100 rows | Without a composite index, repeated user activity reads can scan and sort a large portion of `events` | Read replica |
| `POST /sessions/start` | Inserts one session row and returns it | Write contention at high concurrent login/session starts | Primary |
| `GET /sessions/active` | Filters on `ended_at IS NULL` | Full-table scan unless the active subset has a partial index; result set can also become very large | Read replica |
| `GET /metrics/monthly` | Scans the last 30 days, groups by `event_type` | At 300 million rows/month, this is a large recurring aggregation and can compete with ingestion | Read replica, with future rollups |
| `POST /metrics/feature-usage` | Inserts one feature usage row and returns it | Write volume and index maintenance | Primary |

## Four scalability risks

### 1. The unbounded `events` heap will become operationally expensive

All historical events currently live in one table. Because ingestion adds 10 million rows every day, the heap and its indexes grow without a bounded maintenance unit. Vacuum, index creation, backups, restores, and cache locality all degrade as the table approaches billions of rows. The absence of a time boundary also means every lifecycle operation must reason about the entire event history.

**Mitigation:** partition `events` by `created_at` using monthly range partitions, retain a default partition for operational safety, and move cold partitions to an archive lifecycle rather than allowing the hot table to grow indefinitely.

### 2. The user activity query lacks a supporting composite index

`GET /events?user_id=...` applies an equality predicate on `user_id`, orders by `created_at DESC`, and limits the result to 100 rows. With only the primary-key index on `id`, PostgreSQL may need to inspect many rows and perform a sort before it can return the small result set. That work becomes increasingly expensive as the event table grows.

**Mitigation:** create a covering access path beginning with `user_id` and ordered by `created_at DESC` (implemented as a local index on each event partition). This allows PostgreSQL to retrieve the newest 100 events for a user without scanning unrelated users' events.

### 3. The monthly metrics query repeatedly scans a massive time window

`GET /metrics/monthly` aggregates all events newer than 30 days and groups them by `event_type`. At the current rate, the window contains about 300 million rows. At 10× growth, it contains about 3 billion rows. Running this aggregation on the primary would compete directly with the write path and create latency spikes during dashboards or repeated reporting requests.

**Mitigation:** route the read to a replica and make the time predicate partition-prunable. The next evolution should be daily or hourly rollup tables maintained asynchronously; the current change deliberately keeps the endpoint behavior intact while removing analytical reads from the primary.

### 4. Active-session reads and replica consistency are not addressed

`GET /sessions/active` has no `ended_at` index and can scan the entire sessions table. In addition, moving reads to a replica introduces replication lag: a newly started session or event may not be immediately visible on a replica. If the application uses a single pool, read traffic also consumes primary connections and cannot be isolated from ingestion.

**Mitigation:** add a partial index for active sessions and create separate primary and replica pools. Writes and read-after-write-sensitive operations use the primary; dashboard and monitoring reads use the replica. If `REPLICA_DB_URL` is absent, the application falls back to `PRIMARY_DB_URL`/`DATABASE_URL`, which preserves local development behavior.

## Strategy selection and implementation order

The implementation order is:

1. **Partition the events table first.** The unbounded event heap is the highest-risk issue because it grows by 10 million rows every day and affects storage, maintenance, and query planning. Partitioning establishes the time boundary required by both retention and efficient recent-window scans.
2. **Add the archive lifecycle second.** Once event data is organized into time-based partitions, old partitions can be detached or copied into an archive table without blocking the hot ingestion path. Archiving reduces the active working set and gives retention operations a bounded unit of work.
3. **Route read traffic to a replica third.** Read isolation is valuable, but it should be applied after the query paths and physical layout are corrected. Otherwise, a replica would merely duplicate the same inefficient scans and still require excessive compute and I/O.

## Assumptions and limitations

The row-count estimates for `sessions` and `feature_usage` are planning assumptions, not observed production counts. They assume one row per active user per day. Real values should be replaced with measurements from `COUNT(*)` and time-bucketed queries before capacity procurement. The assignment's event counts are treated as authoritative for this exercise.

The proposed design is an online migration plan, not a claim that an existing 45-million-row table can be altered instantly. A production rollout would create the partitioned structure, backfill in time-bounded batches, validate counts and foreign keys, dual-write or briefly pause ingestion during cutover, and then rename the old table only after verification.
