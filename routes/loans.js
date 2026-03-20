const router = require('express').Router();
const auth   = require('../middleware/auth');
const { pool } = require('../database/db');

/* ── GET /api/loans ──────────────────────────────── */
router.get('/', auth, async (req, res) => {
  const r = await pool.query(
    'SELECT * FROM loans WHERE user_id=$1 ORDER BY created_at DESC',
    [req.user.id]
  );
  res.json({ loans: r.rows });
});

/* ── POST /api/loans/apply ───────────────────────── */
router.post('/apply', auth, async (req, res) => {
  const { amount, reason, duration_months } = req.body;
  if (!amount || !duration_months) return res.status(400).json({ error: 'Amount and duration are required.' });

  const amt = parseFloat(amount);
  if (amt < 100) return res.status(400).json({ error: 'Minimum loan amount is $100.' });
  if (duration_months < 1 || duration_months > 60) return res.status(400).json({ error: 'Duration must be between 1 and 60 months.' });

  // Check for existing active loan
  const existing = await pool.query(
    "SELECT id FROM loans WHERE user_id=$1 AND status IN ('pending','approved')",
    [req.user.id]
  );
  if (existing.rows.length > 0) return res.status(400).json({ error: 'You already have an active or pending loan.' });

  const r = await pool.query(
    `INSERT INTO loans (user_id, amount, reason, duration_months, status)
     VALUES ($1,$2,$3,$4,'pending') RETURNING *`,
    [req.user.id, amt, reason || null, parseInt(duration_months)]
  );

  await pool.query(
    `INSERT INTO notifications (user_id, title, message, type) VALUES ($1,$2,$3,'info')`,
    [req.user.id, 'Loan Application Submitted', `Your loan application for $${amt.toFixed(2)} is under review.`]
  );

  res.status(201).json({ loan: r.rows[0], message: 'Loan application submitted for admin review.' });
});

/* ── GET /api/loans/:id ──────────────────────────── */
router.get('/:id', auth, async (req, res) => {
  const r = await pool.query(
    `SELECT l.*, 
            COALESCE(json_agg(lr ORDER BY lr.created_at DESC) FILTER (WHERE lr.id IS NOT NULL), '[]') as repayments
     FROM loans l
     LEFT JOIN loan_repayments lr ON l.id = lr.loan_id
     WHERE l.id=$1 AND l.user_id=$2
     GROUP BY l.id`,
    [req.params.id, req.user.id]
  );
  if (!r.rows.length) return res.status(404).json({ error: 'Loan not found.' });
  res.json({ loan: r.rows[0] });
});

/* ── POST /api/loans/:id/repay ───────────────────── */
router.post('/:id/repay', auth, async (req, res) => {
  const { amount, notes } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Valid amount required.' });

  const loanR = await pool.query(
    "SELECT * FROM loans WHERE id=$1 AND user_id=$2 AND status='approved'",
    [req.params.id, req.user.id]
  );
  if (!loanR.rows.length) return res.status(404).json({ error: 'Active loan not found.' });
  const loan = loanR.rows[0];

  const amt = parseFloat(amount);
  const remaining = parseFloat(loan.total_repayment) - parseFloat(loan.amount_paid);
  if (amt > remaining) return res.status(400).json({ error: `Maximum repayment is $${remaining.toFixed(2)}.` });

  // Check balance
  const userR = await pool.query('SELECT balance_usd FROM users WHERE id=$1', [req.user.id]);
  if (parseFloat(userR.rows[0].balance_usd) < amt) return res.status(400).json({ error: 'Insufficient balance.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE users SET balance_usd = balance_usd - $1 WHERE id=$2', [amt, req.user.id]);

    await client.query(
      'UPDATE loans SET amount_paid = amount_paid + $1 WHERE id=$2',
      [amt, loan.id]
    );

    await client.query(
      'INSERT INTO loan_repayments (loan_id, user_id, amount, notes) VALUES ($1,$2,$3,$4)',
      [loan.id, req.user.id, amt, notes || null]
    );

    // Check if fully paid
    const newPaid = parseFloat(loan.amount_paid) + amt;
    if (newPaid >= parseFloat(loan.total_repayment)) {
      await client.query("UPDATE loans SET status='completed' WHERE id=$1", [loan.id]);
    }

    await client.query(
      `INSERT INTO notifications (user_id, title, message, type) VALUES ($1,$2,$3,'success')`,
      [req.user.id, 'Loan Repayment Made', `$${amt.toFixed(2)} repayment recorded. Remaining: $${Math.max(0, remaining - amt).toFixed(2)}.`]
    );

    await client.query('COMMIT');
    res.json({ success: true, amount_paid: amt, remaining: Math.max(0, remaining - amt) });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Repayment failed.' });
  } finally {
    client.release();
  }
});

module.exports = router;
