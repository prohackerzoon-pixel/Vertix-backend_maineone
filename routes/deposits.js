const router = require('express').Router();
const auth   = require('../middleware/auth');
const { pool } = require('../database/db');
const { calcFee, toUSD, CURRENCY_RATES } = require('../utils/helpers');

/* ── POST /api/deposits ──────────────────────────── */
router.post('/', auth, async (req, res) => {
  const { amount_original, currency = 'USD', payment_method, reference } = req.body;
  if (!amount_original || amount_original <= 0) return res.status(400).json({ error: 'Enter a valid amount.' });

  const amount_usd = toUSD(parseFloat(amount_original), currency);
  const { fee, net } = calcFee(amount_usd);

  const r = await pool.query(
    `INSERT INTO deposits (user_id, amount_original, currency, amount_usd, fee, net_amount, payment_method, reference, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending')
     RETURNING *`,
    [req.user.id, amount_original, currency, amount_usd, fee, net, payment_method || 'manual', reference || null]
  );

  // Notify admin via notification placeholder (admin sees pending deposits)
  await pool.query(
    `INSERT INTO notifications (user_id, title, message, type) VALUES ($1,$2,$3,$4)`,
    [req.user.id, 'Deposit Request Submitted', `Your deposit of $${amount_usd.toFixed(2)} USD is pending admin approval.`, 'info']
  );

  res.status(201).json({ deposit: r.rows[0], message: 'Deposit request submitted. Awaiting admin approval.' });
});

/* ── GET /api/deposits ───────────────────────────── */
router.get('/', auth, async (req, res) => {
  const r = await pool.query(
    'SELECT * FROM deposits WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50',
    [req.user.id]
  );
  res.json({ deposits: r.rows });
});

/* ── GET /api/deposits/currencies ────────────────── */
router.get('/currencies', (req, res) => {
  res.json({ currencies: Object.keys(CURRENCY_RATES) });
});

module.exports = router;
