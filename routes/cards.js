const router = require('express').Router();
const auth   = require('../middleware/auth');
const { pool } = require('../database/db');
const { generateCardNumber, generateCVV, getCardExpiry } = require('../utils/helpers');

/* ── GET /api/cards ──────────────────────────────── */
router.get('/', auth, async (req, res) => {
  const r = await pool.query('SELECT * FROM virtual_cards WHERE user_id=$1', [req.user.id]);
  res.json({ card: r.rows[0] || null });
});

/* ── POST /api/cards/generate ────────────────────── */
router.post('/generate', auth, async (req, res) => {
  // Check if already has a card
  const existing = await pool.query('SELECT id FROM virtual_cards WHERE user_id=$1', [req.user.id]);
  if (existing.rows.length > 0) return res.status(400).json({ error: 'You already have a virtual card.' });

  // Get user name
  const userR = await pool.query('SELECT first_name, last_name FROM users WHERE id=$1', [req.user.id]);
  const user  = userR.rows[0];

  const cardNumber = generateCardNumber();
  const cvv        = generateCVV();
  const { month, year } = getCardExpiry();
  const holder = `${user.first_name.toUpperCase()} ${user.last_name.toUpperCase()}`;

  const r = await pool.query(
    `INSERT INTO virtual_cards (user_id, card_number, card_holder, expiry_month, expiry_year, cvv, card_type)
     VALUES ($1,$2,$3,$4,$5,$6,'VISA') RETURNING *`,
    [req.user.id, cardNumber, holder, month, year, cvv]
  );

  await pool.query(
    `INSERT INTO notifications (user_id, title, message, type) VALUES ($1,$2,$3,'success')`,
    [req.user.id, 'Virtual Card Generated', 'Your Vertix virtual VISA card has been created successfully.']
  );

  res.status(201).json({ card: r.rows[0] });
});

module.exports = router;
