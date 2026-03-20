const router = require('express').Router();
const auth   = require('../middleware/auth');
const { pool } = require('../database/db');

router.get('/', auth, async (req, res) => {
  const { type, limit = 50 } = req.query;
  const conditions = ['user_id=$1'];
  const params     = [req.user.id];
  if (type) { conditions.push(`type=$${params.length+1}`); params.push(type); }
  const r = await pool.query(
    `SELECT * FROM transactions WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC LIMIT ${parseInt(limit)}`,
    params
  );
  res.json({ transactions: r.rows });
});

router.get('/:id', auth, async (req, res) => {
  const r = await pool.query('SELECT * FROM transactions WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
  if (!r.rows.length) return res.status(404).json({ error: 'Not found.' });
  res.json({ transaction: r.rows[0] });
});

module.exports = router;
