const express = require('express');
const db = require('../db');
const router = express.Router();

/**
 * Generate a monthly summary of event types.
 * This analytical read is isolated on the replica so it cannot compete with
 * event ingestion on the primary. The time predicate also enables partition
 * pruning on the partitioned events table.
 */
router.get('/monthly', async (req, res) => {
  try {
    const result = await db.readQuery(
      "SELECT COUNT(*) AS count, event_type FROM events WHERE created_at >= NOW() - INTERVAL '30 days' GROUP BY event_type ORDER BY count DESC"
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error calculating monthly metrics:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Tracks usage of specific features. Writes stay on the primary.
 */
router.post('/feature-usage', async (req, res) => {
  const { user_id, feature_name } = req.body;

  if (!user_id || !feature_name) {
    return res.status(400).json({ error: 'user_id and feature_name are required' });
  }

  try {
    const result = await db.query(
      'INSERT INTO feature_usage (user_id, feature_name, used_at) VALUES ($1, $2, NOW()) RETURNING *',
      [user_id, feature_name]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Error recording feature usage:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
