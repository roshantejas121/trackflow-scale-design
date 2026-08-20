const { Pool } = require('pg');
require('dotenv').config();

const primaryConnectionString = process.env.PRIMARY_DB_URL || process.env.DATABASE_URL;
const replicaConnectionString = process.env.REPLICA_DB_URL || primaryConnectionString;

if (!primaryConnectionString) {
  throw new Error('PRIMARY_DB_URL or DATABASE_URL must be configured');
}

const poolOptions = {
  max: Number(process.env.DB_POOL_MAX || 20),
  idleTimeoutMillis: Number(process.env.DB_IDLE_TIMEOUT_MS || 30000),
  connectionTimeoutMillis: Number(process.env.DB_CONNECTION_TIMEOUT_MS || 5000),
};

const primaryPool = new Pool({
  ...poolOptions,
  connectionString: primaryConnectionString,
});

const replicaPool = new Pool({
  ...poolOptions,
  connectionString: replicaConnectionString,
});

primaryPool.on('error', (err) => console.error('Unexpected primary database pool error:', err));
replicaPool.on('error', (err) => console.error('Unexpected replica database pool error:', err));

module.exports = {
  // Writes and read-after-write-sensitive queries always use the primary.
  query: (text, params) => primaryPool.query(text, params),
  // Dashboard and monitoring reads can be scaled independently on a replica.
  readQuery: (text, params) => replicaPool.query(text, params),
  primaryPool,
  replicaPool,
};
