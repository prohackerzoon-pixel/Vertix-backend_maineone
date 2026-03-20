const router = require('express').Router();
const auth   = require('../middleware/auth');
const { pool } = require('../database/db');
const { calcFee, KYC_LIMITS } = require('../utils/helpers');

/* ── POST /api/withdrawals ───────────────────────── */
router.post('/', auth, async (req, res) => {
  const { amount, bank_name, bank_account_number, account_name } = req.body;
  const userId = req.user.id;

  if (!amount || amount < 10) return res.status(400).json({ error: 'Minimum withdrawal is $10.' });
  if (!bank_name || !bank_account_number || !account_name) return res.status(400).json({ error: 'All bank details are required.' });

  const amt = parseFloat(amount);

  // Get user
  const userR = await pool.query('SELECT * FROM users WHERE id=$1', [userId]);
  const user  = userR.rows[0];
  // Note: PIN not required for withdrawals — 3-step code verification is sufficient security

  // Check KYC daily limit
  const kycLimits = KYC_LIMITS[user.kyc_level] || KYC_LIMITS[0];
  if (kycLimits.daily !== null) {
    const dailyR = await pool.query(
      `SELECT COALESCE(SUM(amount),0) as total FROM transactions
       WHERE user_id=$1 AND type IN ('transfer','withdrawal') AND status='completed'
       AND created_at >= CURRENT_DATE`,
      [userId]
    );
    if (parseFloat(dailyR.rows[0].total) + amt > kycLimits.daily) {
      return res.status(400).json({ error: `Daily limit of $${kycLimits.daily} exceeded. Upgrade KYC to increase limits.` });
    }
  }

  if (parseFloat(user.balance_usd) < amt) return res.status(400).json({ error: 'Insufficient balance.' });

  const { fee, net } = calcFee(amt);

  // Hold balance (deduct immediately, refund on rejection)
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE users SET balance_usd = balance_usd - $1 WHERE id=$2', [amt, userId]);

    const wd = await client.query(
      `INSERT INTO withdrawals (user_id, amount, fee, net_amount, bank_name, bank_account_number, account_name, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'pending') RETURNING *`,
      [userId, amt, fee, net, bank_name, bank_account_number, account_name]
    );

    await client.query(
      `INSERT INTO notifications (user_id, title, message, type) VALUES ($1,$2,$3,'info')`,
      [userId, 'Withdrawal Request Submitted', `Your withdrawal of $${amt.toFixed(2)} is pending admin approval. Fee: $${fee.toFixed(2)}, You receive: $${net.toFixed(2)}.`]
    );

    await client.query('COMMIT');
    res.status(201).json({ withdrawal: wd.rows[0] });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Withdrawal failed. Please try again.' });
  } finally {
    client.release();
  }
});

/* ── GET /api/withdrawals ────────────────────────── */
router.get('/', auth, async (req, res) => {
  const r = await pool.query(
    'SELECT * FROM withdrawals WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50',
    [req.user.id]
  );
  res.json({ withdrawals: r.rows });
});

/* ── GET /api/withdrawals/:id ────────────────────── */
router.get('/:id', auth, async (req, res) => {
  const r = await pool.query(
    'SELECT * FROM withdrawals WHERE id=$1 AND user_id=$2',
    [req.params.id, req.user.id]
  );
  if (!r.rows.length) return res.status(404).json({ error: 'Not found.' });
  res.json({ withdrawal: r.rows[0] });
});

module.exports = router;
