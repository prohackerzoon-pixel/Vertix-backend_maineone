const router = require('express').Router();
const bcrypt = require('bcryptjs');
const auth   = require('../middleware/auth');
const { pool } = require('../database/db');
const { calcFee, KYC_LIMITS } = require('../utils/helpers');

/* ── POST /api/transfers ─────────────────────────── */
router.post('/', auth, async (req, res) => {
  const { recipient_account_number, amount, description, pin } = req.body;
  const senderId = req.user.id;

  if (!recipient_account_number || !amount) return res.status(400).json({ error: 'Recipient and amount are required.' });
  const amt = parseFloat(amount);
  if (amt < 5) return res.status(400).json({ error: 'Minimum transfer is $5.' });

  // Get sender
  const senderR = await pool.query('SELECT * FROM users WHERE id=$1', [senderId]);
  const sender  = senderR.rows[0];

  // Verify PIN if set
  if (sender.transaction_pin) {
    if (!pin) return res.status(400).json({ error: 'Transaction PIN required.' });
    const validPin = await bcrypt.compare(pin, sender.transaction_pin);
    if (!validPin) return res.status(400).json({ error: 'Incorrect transaction PIN.' });
  }

  // Check KYC daily limit
  const kycLimits = KYC_LIMITS[sender.kyc_level] || KYC_LIMITS[0];
  if (kycLimits.daily !== null) {
    const dailyR = await pool.query(
      `SELECT COALESCE(SUM(amount),0) as total FROM transactions
       WHERE user_id=$1 AND type IN ('transfer','withdrawal') AND status='completed'
       AND created_at >= CURRENT_DATE`,
      [senderId]
    );
    const dailyTotal = parseFloat(dailyR.rows[0].total) + amt;
    if (dailyTotal > kycLimits.daily) {
      return res.status(400).json({ error: `Daily transaction limit of $${kycLimits.daily} reached. Complete KYC to increase your limit.` });
    }
  }

  // Check balance
  if (parseFloat(sender.balance_usd) < amt) return res.status(400).json({ error: 'Insufficient balance.' });

  // Get recipient
  const recipR = await pool.query('SELECT * FROM users WHERE account_number=$1', [recipient_account_number]);
  if (!recipR.rows.length) return res.status(404).json({ error: 'Recipient account not found.' });
  const recipient = recipR.rows[0];
  if (recipient.id === senderId) return res.status(400).json({ error: 'Cannot transfer to yourself.' });
  if (recipient.status === 'frozen') return res.status(400).json({ error: 'Recipient account is frozen.' });

  // Check recipient balance limit
  const recipLimits = KYC_LIMITS[recipient.kyc_level] || KYC_LIMITS[0];
  const { fee, net } = calcFee(amt);
  if (recipLimits.maxBalance !== null) {
    const newBalance = parseFloat(recipient.balance_usd) + net;
    if (newBalance > recipLimits.maxBalance) {
      return res.status(400).json({ error: `Recipient has reached their account balance limit. They need to complete KYC to receive more.` });
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Deduct from sender
    await client.query('UPDATE users SET balance_usd = balance_usd - $1 WHERE id=$2', [amt, senderId]);
    // Add net to recipient
    await client.query('UPDATE users SET balance_usd = balance_usd + $1 WHERE id=$2', [net, recipient.id]);

    // Transfer record
    const txfr = await client.query(
      `INSERT INTO transfers (sender_id, recipient_id, amount, fee, net_amount, description, status)
       VALUES ($1,$2,$3,$4,$5,$6,'completed') RETURNING *`,
      [senderId, recipient.id, amt, fee, net, description || null]
    );

    // Transaction records
    await client.query(
      `INSERT INTO transactions (user_id, type, amount, fee, net_amount, description, status, reference)
       VALUES ($1,'transfer',$2,$3,$4,$5,'completed',$6)`,
      [senderId, amt, fee, amt - fee, `Transfer to ${recipient.first_name} ${recipient.last_name}`, `TXF-${txfr.rows[0].id}`]
    );
    await client.query(
      `INSERT INTO transactions (user_id, type, amount, fee, net_amount, description, status, reference)
       VALUES ($1,'transfer',$2,0,$2,$3,'completed',$4)`,
      [recipient.id, net, `Received from ${sender.first_name} ${sender.last_name}`, `TXF-${txfr.rows[0].id}`]
    );

    // Fee to charge account
    await client.query(
      `INSERT INTO charge_account (source_type, source_id, user_id, amount, description)
       VALUES ('transfer',$1,$2,$3,$4)`,
      [txfr.rows[0].id, senderId, fee, `Transfer fee from ${sender.first_name} ${sender.last_name}`]
    );

    // Notifications
    await client.query(
      `INSERT INTO notifications (user_id, title, message, type) VALUES ($1,$2,$3,'info')`,
      [senderId, 'Transfer Sent', `You sent $${amt.toFixed(2)} to ${recipient.first_name} ${recipient.last_name}. Fee: $${fee.toFixed(2)}.`]
    );
    await client.query(
      `INSERT INTO notifications (user_id, title, message, type) VALUES ($1,$2,$3,'success')`,
      [recipient.id, 'Money Received!', `You received $${net.toFixed(2)} from ${sender.first_name} ${sender.last_name}.`]
    );

    await client.query('COMMIT');
    res.status(201).json({
      success: true,
      transfer: { amount: amt, fee, amount_received: net, recipient: `${recipient.first_name} ${recipient.last_name}` }
    });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Transfer error:', e.message);
    res.status(500).json({ error: 'Transfer failed. Please try again.' });
  } finally {
    client.release();
  }
});

/* ── GET /api/transfers ──────────────────────────── */
router.get('/', auth, async (req, res) => {
  const r = await pool.query(
    `SELECT t.*, 
            s.first_name||' '||s.last_name as sender_name,
            rc.first_name||' '||rc.last_name as recipient_name
     FROM transfers t
     LEFT JOIN users s  ON t.sender_id=s.id
     LEFT JOIN users rc ON t.recipient_id=rc.id
     WHERE t.sender_id=$1 OR t.recipient_id=$1
     ORDER BY t.created_at DESC LIMIT 50`,
    [req.user.id]
  );
  res.json({ transfers: r.rows });
});

module.exports = router;
