const express = require('express');
const db = require('../db');
const router = express.Router();

/**
 * Start a new user session. Writes use the primary database.
 */
router.post('/start', async (req, res) => {
  const { user_id } = req.body;

  if (!user_id) {
    return res.status(400).json({ error: 'user_id is required' });
  }

  try {
    const result = await db.query(
      'INSERT INTO sessions (user_id, started_at) VALUES ($1, NOW()) RETURNING *',
      [user_id]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Error starting session:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * List currently active sessions. This monitoring read uses the replica and
 * the partial ended_at index defined in schema.sql.
 */
router.get('/active', async (req, res) => {
  try {
    const result = await db.readQuery(
      'SELECT * FROM sessions WHERE ended_at IS NULL ORDER BY started_at DESC'
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching active sessions:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
