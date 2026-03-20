const router = require('express').Router();
const auth   = require('../middleware/auth');
const { pool } = require('../database/db');

/* ── GET /api/savings/plans ──────────────────────── */
router.get('/plans', async (req, res) => {
  const r = await pool.query('SELECT * FROM savings_plans WHERE is_active=TRUE ORDER BY duration_days');
  res.json({ plans: r.rows });
});

/* ── GET /api/savings/my-investments ─────────────── */
router.get('/my-investments', auth, async (req, res) => {
  const r = await pool.query(
    `SELECT si.*, sp.name as plan_name, sp.description as plan_description
     FROM savings_investments si
     JOIN savings_plans sp ON si.plan_id = sp.id
     WHERE si.user_id=$1 ORDER BY si.created_at DESC`,
    [req.user.id]
  );
  res.json({ investments: r.rows });
});

/* ── POST /api/savings/invest ────────────────────── */
router.post('/invest', auth, async (req, res) => {
  const { plan_id, amount } = req.body;
  if (!plan_id || !amount) return res.status(400).json({ error: 'Plan and amount are required.' });

  const amt = parseFloat(amount);

  // Get plan
  const planR = await pool.query('SELECT * FROM savings_plans WHERE id=$1 AND is_active=TRUE', [plan_id]);
  if (!planR.rows.length) return res.status(404).json({ error: 'Plan not found.' });
  const plan = planR.rows[0];

  if (amt < parseFloat(plan.minimum_amount)) {
    return res.status(400).json({ error: `Minimum investment for this plan is $${plan.minimum_amount}.` });
  }
  if (plan.maximum_amount && amt > parseFloat(plan.maximum_amount)) {
    return res.status(400).json({ error: `Maximum investment for this plan is $${plan.maximum_amount}.` });
  }

  // Check balance
  const userR = await pool.query('SELECT balance_usd FROM users WHERE id=$1', [req.user.id]);
  if (parseFloat(userR.rows[0].balance_usd) < amt) {
    return res.status(400).json({ error: 'Insufficient balance.' });
  }

  const interest      = amt * (parseFloat(plan.interest_rate) / 100);
  const expectedReturn = parseFloat((amt + interest).toFixed(2));
  const maturityDate  = new Date(Date.now() + plan.duration_days * 24 * 60 * 60 * 1000);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE users SET balance_usd = balance_usd - $1 WHERE id=$2', [amt, req.user.id]);

    const inv = await client.query(
      `INSERT INTO savings_investments (user_id, plan_id, amount, interest_rate, expected_return, maturity_date)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.user.id, plan_id, amt, plan.interest_rate, expectedReturn, maturityDate]
    );

    await client.query(
      `INSERT INTO notifications (user_id, title, message, type) VALUES ($1,$2,$3,'success')`,
      [req.user.id, 'Investment Started!', `$${amt.toFixed(2)} invested in ${plan.name}. Expected return: $${expectedReturn.toFixed(2)} in ${plan.duration_days} days.`]
    );

    await client.query('COMMIT');
    res.status(201).json({ investment: inv.rows[0] });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Investment failed. Please try again.' });
  } finally {
    client.release();
  }
});

/* ── POST /api/savings/withdraw/:id ──────────────── */
router.post('/withdraw/:id', auth, async (req, res) => {
  const invR = await pool.query(
    "SELECT si.*, sp.name as plan_name FROM savings_investments si JOIN savings_plans sp ON si.plan_id=sp.id WHERE si.id=$1 AND si.user_id=$2 AND si.status='active'",
    [req.params.id, req.user.id]
  );
  if (!invR.rows.length) return res.status(404).json({ error: 'Active investment not found.' });
  const inv = invR.rows[0];

  const now = new Date();
  const maturity = new Date(inv.maturity_date);
  const matured  = now >= maturity;
  const payout   = matured ? parseFloat(inv.expected_return) : parseFloat(inv.amount); // no interest if early

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE users SET balance_usd = balance_usd + $1 WHERE id=$2', [payout, req.user.id]);
    await client.query(
      "UPDATE savings_investments SET status='completed', actual_return=$1 WHERE id=$2",
      [payout, inv.id]
    );
    await client.query(
      `INSERT INTO notifications (user_id, title, message, type) VALUES ($1,$2,$3,$4)`,
      [req.user.id,
       matured ? 'Investment Matured!' : 'Early Withdrawal',
       matured
         ? `Your ${inv.plan_name} investment matured! $${payout.toFixed(2)} returned to your balance.`
         : `Early withdrawal of $${payout.toFixed(2)} from ${inv.plan_name}. Interest forfeited.`,
       matured ? 'success' : 'info']
    );
    await client.query('COMMIT');
    res.json({ success: true, payout, matured });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Withdrawal failed.' });
  } finally {
    client.release();
  }
});

module.exports = router;
