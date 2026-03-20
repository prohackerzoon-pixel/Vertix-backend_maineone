const router = require('express').Router();
const auth   = require('../middleware/auth');
const { pool } = require('../database/db');

/* ── GET /api/kyc/status ─────────────────────────── */
router.get('/status', auth, async (req, res) => {
  const userR = await pool.query('SELECT kyc_level FROM users WHERE id=$1', [req.user.id]);
  const submissions = await pool.query(
    'SELECT id, level, status, admin_note, submitted_at, reviewed_at FROM kyc_submissions WHERE user_id=$1 ORDER BY level',
    [req.user.id]
  );
  res.json({ kyc_level: userR.rows[0].kyc_level, submissions: submissions.rows });
});

/* ── GET /api/kyc/my-submissions ─────────────────── */
router.get('/my-submissions', auth, async (req, res) => {
  const r = await pool.query(
    'SELECT id,level,status,admin_note,submitted_at,reviewed_at FROM kyc_submissions WHERE user_id=$1 ORDER BY submitted_at DESC',
    [req.user.id]
  );
  res.json({ submissions: r.rows });
});

/* ── POST /api/kyc/submit/:level ─────────────────── */
router.post('/submit/:level', auth, async (req, res) => {
  const level  = parseInt(req.params.level);
  const userId = req.user.id;

  if (![1, 2, 3].includes(level)) return res.status(400).json({ error: 'Invalid KYC level.' });

  // Check prerequisites - must have previous level approved
  if (level > 1) {
    const userR = await pool.query('SELECT kyc_level FROM users WHERE id=$1', [userId]);
    if (userR.rows[0].kyc_level < level - 1) {
      return res.status(400).json({ error: `You must complete KYC Level ${level - 1} first.` });
    }
  }

  // Check if already pending or approved for this level
  const existing = await pool.query(
    "SELECT id, status FROM kyc_submissions WHERE user_id=$1 AND level=$2 ORDER BY submitted_at DESC LIMIT 1",
    [userId, level]
  );
  if (existing.rows.length > 0 && existing.rows[0].status === 'pending') {
    return res.status(400).json({ error: 'You already have a pending KYC submission for this level.' });
  }
  if (existing.rows.length > 0 && existing.rows[0].status === 'approved') {
    return res.status(400).json({ error: 'This KYC level is already approved.' });
  }

  let insertData = {};

  if (level === 1) {
    const { house_address, city, state, zip_code, country, date_of_birth, nationality } = req.body;
    if (!house_address || !city || !state || !zip_code || !country || !date_of_birth) {
      return res.status(400).json({ error: 'All address fields are required for KYC Level 1.' });
    }
    insertData = { house_address, city, state, zip_code, country, date_of_birth, nationality };
  } else if (level === 2) {
    const { document_type, document_number, document_front, document_back } = req.body;
    if (!document_type || !document_number || !document_front) {
      return res.status(400).json({ error: 'Document type, number, and front image are required for KYC Level 2.' });
    }
    insertData = { document_type, document_number, document_front, document_back: document_back || null };
  } else if (level === 3) {
    const { card_holder_name, card_last_four, card_type } = req.body;
    if (!card_holder_name || !card_last_four) {
      return res.status(400).json({ error: 'Card holder name and last 4 digits are required for KYC Level 3.' });
    }
    insertData = { card_holder_name, card_last_four, card_type: card_type || 'VISA' };
  }

  const r = await pool.query(
    `INSERT INTO kyc_submissions
      (user_id, level, house_address, city, state, zip_code, country, date_of_birth, nationality,
       document_type, document_number, document_front, document_back,
       card_holder_name, card_last_four, card_type, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'pending')
     RETURNING id, level, status, submitted_at`,
    [
      userId, level,
      insertData.house_address || null, insertData.city || null,
      insertData.state || null, insertData.zip_code || null,
      insertData.country || null, insertData.date_of_birth || null,
      insertData.nationality || null, insertData.document_type || null,
      insertData.document_number || null, insertData.document_front || null,
      insertData.document_back || null, insertData.card_holder_name || null,
      insertData.card_last_four || null, insertData.card_type || null
    ]
  );

  await pool.query(
    `INSERT INTO notifications (user_id, title, message, type) VALUES ($1,$2,$3,'info')`,
    [userId, `KYC Level ${level} Submitted`, `Your KYC Level ${level} verification is under review. You'll be notified once reviewed.`]
  );

  res.status(201).json({ submission: r.rows[0], message: 'KYC submitted for review.' });
});

module.exports = router;
