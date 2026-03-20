const router = require('express').Router();
const auth   = require('../middleware/auth');
const { pool } = require('../database/db');

router.get('/', auth, async (req, res) => {
  const r = await pool.query(
    'SELECT * FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50',
    [req.user.id]
  );
  res.json({ notifications: r.rows });
});

router.put('/:id/read', auth, async (req, res) => {
  await pool.query('UPDATE notifications SET is_read=TRUE WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
  res.json({ success: true });
});

router.put('/read-all', auth, async (req, res) => {
  await pool.query('UPDATE notifications SET is_read=TRUE WHERE user_id=$1', [req.user.id]);
  res.json({ success: true });
});

module.exports = router;
