const router = require('express').Router();
const { pool } = require('../database/db');

router.get('/', async (req, res) => {
  const r = await pool.query('SELECT * FROM crypto_prices ORDER BY id');
  res.json({ coins: r.rows });
});

router.get('/:symbol', async (req, res) => {
  const r = await pool.query('SELECT * FROM crypto_prices WHERE symbol=$1', [req.params.symbol.toUpperCase()]);
  if (!r.rows.length) return res.status(404).json({ error: 'Coin not found.' });
  res.json({ coin: r.rows[0] });
});

module.exports = router;
