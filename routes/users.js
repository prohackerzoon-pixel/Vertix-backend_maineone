const router = require('express').Router();
const bcrypt = require('bcryptjs');
const auth   = require('../middleware/auth');
const { pool } = require('../database/db');

/* ── GET /api/users/me ──────────────────────────── */
router.get('/me', auth, async (req, res) => {
  const r = await pool.query(
    `SELECT id,first_name,last_name,email,username,phone,country,balance_usd,
            account_number,profile_photo,kyc_level,referral_code,status,created_at
     FROM users WHERE id=$1`, [req.user.id]
  );
  if (!r.rows.length) return res.status(404).json({ error: 'User not found' });
  res.json({ user: r.rows[0] });
});

/* ── GET /api/users/dashboard ───────────────────── */
router.get('/dashboard', auth, async (req, res) => {
  try {
    const uid = req.user.id;
    const [userR, wdR, chatR, notifR, txR, loanR, savR] = await Promise.all([
      pool.query(`SELECT id,first_name,last_name,email,username,phone,country,balance_usd,
                         account_number,profile_photo,kyc_level,referral_code,status,created_at
                  FROM users WHERE id=$1`, [uid]),
      pool.query(`SELECT COUNT(*) FROM withdrawals WHERE user_id=$1 AND status='pending'`, [uid]),
      pool.query(`SELECT COUNT(*) FROM chat_messages WHERE user_id=$1 AND sender_type='admin' AND is_read=FALSE`, [uid]),
      pool.query(`SELECT COUNT(*) FROM notifications WHERE user_id=$1 AND is_read=FALSE`, [uid]),
      pool.query(`SELECT type,amount,fee,net_amount,status,created_at FROM transactions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 5`, [uid]),
      pool.query(`SELECT COUNT(*) FROM loans WHERE user_id=$1 AND status='approved'`, [uid]),
      pool.query(`SELECT COUNT(*) FROM savings_investments WHERE user_id=$1 AND status='active'`, [uid]),
    ]);
    if (!userR.rows.length) return res.status(404).json({ error: 'User not found' });
    res.json({
      user:          userR.rows[0],
      pendingWd:     parseInt(wdR.rows[0].count),
      unreadChat:    parseInt(chatR.rows[0].count),
      unreadNotif:   parseInt(notifR.rows[0].count),
      recentTx:      txR.rows,
      activeLoans:   parseInt(loanR.rows[0].count),
      activeSavings: parseInt(savR.rows[0].count),
    });
  } catch(e) {
    console.error(e.message);
    res.status(500).json({ error: 'Dashboard load failed' });
  }
});

/* ── PUT /api/users/me ──────────────────────────── */
router.put('/me', auth, async (req, res) => {
  const { first_name, last_name, phone, country } = req.body;
  const r = await pool.query(
    `UPDATE users SET first_name=COALESCE($1,first_name), last_name=COALESCE($2,last_name),
     phone=COALESCE($3,phone), country=COALESCE($4,country)
     WHERE id=$5 RETURNING id,first_name,last_name,email,username,phone,country`,
    [first_name, last_name, phone, country, req.user.id]
  );
  res.json({ user: r.rows[0] });
});

/* ── PUT /api/users/change-password ─────────────── */
router.put('/change-password', auth, async (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) return res.status(400).json({ error: 'All fields required.' });
  if (new_password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });

  const r = await pool.query('SELECT password_hash FROM users WHERE id=$1', [req.user.id]);
  const valid = await bcrypt.compare(current_password, r.rows[0].password_hash);
  if (!valid) return res.status(400).json({ error: 'Current password is incorrect.' });

  const hash = await bcrypt.hash(new_password, 10);
  await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, req.user.id]);
  res.json({ success: true });
});

/* ── GET /api/users/lookup/:accountNumber ────────── */
router.get('/lookup/:accountNumber', auth, async (req, res) => {
  const r = await pool.query(
    'SELECT id,first_name,last_name,username,account_number,status FROM users WHERE account_number=$1',
    [req.params.accountNumber]
  );
  if (!r.rows.length) return res.status(404).json({ error: 'Account not found.' });
  const u = r.rows[0];
  if (u.id === req.user.id) return res.status(400).json({ error: 'Cannot transfer to yourself.' });
  if (u.status === 'frozen') return res.status(400).json({ error: 'Recipient account is frozen.' });
  res.json({ user: u });
});

/* ── PUT /api/users/profile-photo ────────────────── */
router.put('/profile-photo', auth, async (req, res) => {
  const { photo } = req.body;
  if (!photo) return res.status(400).json({ error: 'No photo provided.' });
  await pool.query('UPDATE users SET profile_photo=$1 WHERE id=$2', [photo, req.user.id]);
  res.json({ success: true });
});

/* ── POST /api/users/set-pin ─────────────────────── */
router.post('/set-pin', auth, async (req, res) => {
  const { pin, password } = req.body;
  if (!pin || pin.length !== 4 || !/^\d{4}$/.test(pin)) {
    return res.status(400).json({ error: 'PIN must be exactly 4 digits.' });
  }
  // Verify password before setting PIN
  const r = await pool.query('SELECT password_hash FROM users WHERE id=$1', [req.user.id]);
  const valid = await bcrypt.compare(password, r.rows[0].password_hash);
  if (!valid) return res.status(400).json({ error: 'Incorrect password.' });

  const pinHash = await bcrypt.hash(pin, 10);
  await pool.query('UPDATE users SET transaction_pin=$1 WHERE id=$2', [pinHash, req.user.id]);
  res.json({ success: true, message: 'Transaction PIN set successfully.' });
});

/* ── POST /api/users/verify-pin ──────────────────── */
router.post('/verify-pin', auth, async (req, res) => {
  const { pin } = req.body;
  if (!pin) return res.status(400).json({ error: 'PIN required.' });
  const r = await pool.query('SELECT transaction_pin FROM users WHERE id=$1', [req.user.id]);
  if (!r.rows[0].transaction_pin) return res.status(400).json({ error: 'No PIN set. Please set your transaction PIN first.' });
  const valid = await bcrypt.compare(pin, r.rows[0].transaction_pin);
  if (!valid) return res.status(400).json({ error: 'Incorrect PIN.' });
  res.json({ success: true });
});

/* ── GET /api/users/pin-status ───────────────────── */
router.get('/pin-status', auth, async (req, res) => {
  const r = await pool.query('SELECT transaction_pin FROM users WHERE id=$1', [req.user.id]);
  res.json({ has_pin: !!r.rows[0].transaction_pin });
});

module.exports = router;
