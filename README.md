# TrackFlow API

TrackFlow is a high-performance event tracking and analytics API designed for early-stage startups. It provides a simple, robust interface for logging user interactions, managing sessions, and generating aggregate metrics while keeping high-volume writes separate from analytical reads.

## Live Deployment

**Live URL:** `TBD — configure the Render or Railway service URL here before submission.`

The application is designed to run as a Node.js web service with PostgreSQL. Set the deployed service's `PRIMARY_DB_URL` and `REPLICA_DB_URL` environment variables. For the assignment demo, both variables may point to the same PostgreSQL database; the application still exercises the primary/replica routing code paths.

## Getting Started

### Prerequisites

- Node.js v18 or later
- PostgreSQL v14 or later

### Installation

1. Clone the repository.
2. Install dependencies:

   ```bash
   npm install
   ```

3. Create a `.env` file based on `.env.example`:

   ```env
   PRIMARY_DB_URL=postgres://user:password@localhost:5432/trackflow
   REPLICA_DB_URL=postgres://user:password@localhost:5432/trackflow
   PORT=3000
   ```

   If `REPLICA_DB_URL` is omitted, it falls back to `PRIMARY_DB_URL`. The legacy `DATABASE_URL` variable is also accepted as a primary fallback.

4. Initialize the database schema:

   ```bash
   psql -d trackflow -f schema.sql
   ```

5. Start the server:

   ```bash
   npm start
   ```

## API Endpoints

### Events

- `POST /events` — Ingest a new event on the primary database.
- `GET /events?user_id={id}` — Read the most recent 100 events for a user from the replica.

### Sessions

- `POST /sessions/start` — Start a new user session on the primary database.
- `GET /sessions/active` — List active sessions from the replica using a partial index on `ended_at IS NULL`.

### Metrics

- `GET /metrics/monthly` — Read the last-30-day event distribution from the replica.
- `POST /metrics/feature-usage` — Log feature interaction on the primary database.

## Scale Design

The `events` table is range-partitioned by month on `created_at`. Each partition receives a local `(user_id, created_at DESC)` index for the recent activity feed, and the schema includes a default partition for safe handling of dates outside the pre-created window. Cold events can be moved into `events_archive` with the `archive_events_before(cutoff)` function.

The database helper creates independent primary and replica pools. Writes remain on the primary, while the event feed, active-session monitor, and monthly analytics read from the replica. When both URLs point to the same database, the behavior remains fully testable in local development. Because replica reads are eventually consistent, a newly written row may briefly be absent from a subsequent dashboard read.

The detailed calculations and risk analysis are in [GROWTH-ANALYSIS.md](./GROWTH-ANALYSIS.md). The implementation order, affected routes, and trade-offs are in [SCALE-PLAN.md](./SCALE-PLAN.md).

## Growth Context

- **Current active users:** 50,000
- **Average events per user per day:** 200
- **Daily event row growth:** 10,000,000 rows/day
- **Current events table size:** 45,000,000 rows (4.5 days of data)
- **Projected monthly growth:** 300,000,000 rows

---

Developed for the Engineering Challenge on Large-Scale Data Growth Strategies.
