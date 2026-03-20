const router  = require('express').Router();
const adminAuth = require('../middleware/adminAuth');
const { pool }  = require('../database/db');
const { calcFee, generateWithdrawalCode } = require('../utils/helpers');

/* ═══════════════════════════════════
   DASHBOARD
═══════════════════════════════════ */
router.get('/dashboard', adminAuth, async (req, res) => {
  try {
    const [users, fees, pendingWd, chats, deps, txfr, wd, frozen, kyc] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM users'),
      pool.query('SELECT COALESCE(SUM(amount),0) as total FROM charge_account'),
      pool.query("SELECT COUNT(*) FROM withdrawals WHERE status='pending'"),
      pool.query("SELECT COUNT(*) FROM chat_messages WHERE sender_type='user' AND is_read=FALSE"),
      pool.query("SELECT COALESCE(SUM(amount_usd),0) as total FROM deposits WHERE status='approved'"),
      pool.query("SELECT COALESCE(SUM(amount),0) as total FROM transfers"),
      pool.query("SELECT COALESCE(SUM(amount),0) as total FROM withdrawals WHERE status='approved'"),
      pool.query("SELECT COUNT(*) FROM users WHERE status='frozen'"),
      pool.query("SELECT COUNT(*) FROM kyc_submissions WHERE status='pending'"),
    ]);
    res.json({
      totalUsers:    parseInt(users.rows[0].count),
      totalFees:     parseFloat(fees.rows[0].total),
      pendingWd:     parseInt(pendingWd.rows[0].count),
      unreadChats:   parseInt(chats.rows[0].count),
      totalDeposits: parseFloat(deps.rows[0].total),
      totalTransfers:parseFloat(txfr.rows[0].total),
      totalWd:       parseFloat(wd.rows[0].total),
      frozenUsers:   parseInt(frozen.rows[0].count),
      pendingKyc:    parseInt(kyc.rows[0].count),
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

/* ═══════════════════════════════════
   USERS
═══════════════════════════════════ */
router.get('/users', adminAuth, async (req, res) => {
  const { search = '' } = req.query;
  const r = await pool.query(
    `SELECT id,first_name,last_name,email,username,account_number,balance_usd,kyc_level,status,created_at,phone,country,referral_code
     FROM users
     WHERE first_name ILIKE $1 OR last_name ILIKE $1 OR email ILIKE $1
           OR account_number ILIKE $1 OR username ILIKE $1
     ORDER BY created_at DESC`,
    [`%${search}%`]
  );
  res.json({ users: r.rows });
});

router.get('/users/:id', adminAuth, async (req, res) => {
  const r = await pool.query(
    `SELECT id,first_name,last_name,email,username,account_number,balance_usd,
            kyc_level,status,created_at,phone,country,referral_code,profile_photo
     FROM users WHERE id=$1`,
    [req.params.id]
  );
  if (!r.rows.length) return res.status(404).json({ error: 'User not found.' });
  res.json({ user: r.rows[0] });
});

router.put('/users/:id/balance', adminAuth, async (req, res) => {
  const { type, amount } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Valid amount required.' });
  const amt = parseFloat(amount);
  let query;
  if (type === 'add')       query = 'UPDATE users SET balance_usd = balance_usd + $1 WHERE id=$2';
  else if (type === 'subtract') query = 'UPDATE users SET balance_usd = GREATEST(0, balance_usd - $1) WHERE id=$2';
  else if (type === 'set')  query = 'UPDATE users SET balance_usd = $1 WHERE id=$2';
  else return res.status(400).json({ error: 'Invalid type.' });

  await pool.query(query, [amt, req.params.id]);
  await pool.query(
    `INSERT INTO notifications (user_id, title, message, type) VALUES ($1,$2,$3,'info')`,
    [req.params.id, 'Balance Updated', `Your account balance has been updated by the admin.`]
  );
  res.json({ success: true });
});

router.put('/users/:id/status', adminAuth, async (req, res) => {
  const { status } = req.body;
  if (!['active','frozen'].includes(status)) return res.status(400).json({ error: 'Invalid status.' });
  await pool.query('UPDATE users SET status=$1 WHERE id=$2', [status, req.params.id]);
  await pool.query(
    `INSERT INTO notifications (user_id, title, message, type) VALUES ($1,$2,$3,$4)`,
    [req.params.id,
     status === 'frozen' ? 'Account Frozen' : 'Account Reactivated',
     status === 'frozen' ? 'Your account has been frozen. Contact support for assistance.' : 'Your account has been reactivated.',
     status === 'frozen' ? 'error' : 'success']
  );
  res.json({ success: true });
});

/* ═══════════════════════════════════
   DEPOSITS
═══════════════════════════════════ */
router.get('/deposits', adminAuth, async (req, res) => {
  const { status } = req.query;
  const conditions = status ? `WHERE d.status=$1` : '';
  const params     = status ? [status] : [];
  const r = await pool.query(
    `SELECT d.*, u.first_name, u.last_name, u.account_number, u.email
     FROM deposits d JOIN users u ON d.user_id=u.id
     ${conditions} ORDER BY d.created_at DESC LIMIT 100`,
    params
  );
  res.json({ deposits: r.rows });
});

router.put('/deposits/:id', adminAuth, async (req, res) => {
  const { status, admin_note } = req.body;
  if (!['approved','rejected'].includes(status)) return res.status(400).json({ error: 'Invalid status.' });

  const depR = await pool.query('SELECT * FROM deposits WHERE id=$1', [req.params.id]);
  if (!depR.rows.length) return res.status(404).json({ error: 'Deposit not found.' });
  const dep = depR.rows[0];
  if (dep.status !== 'pending') return res.status(400).json({ error: 'Already processed.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE deposits SET status=$1, admin_note=$2 WHERE id=$3', [status, admin_note || null, dep.id]);

    if (status === 'approved') {
      await client.query('UPDATE users SET balance_usd = balance_usd + $1 WHERE id=$2', [dep.net_amount, dep.user_id]);
      await client.query(
        `INSERT INTO transactions (user_id, type, amount, fee, net_amount, description, status)
         VALUES ($1,'deposit',$2,$3,$4,$5,'completed')`,
        [dep.user_id, dep.amount_usd, dep.fee, dep.net_amount, `Deposit approved - ${dep.payment_method}`]
      );
      await client.query(
        `INSERT INTO charge_account (source_type, source_id, user_id, amount, description)
         VALUES ('deposit',$1,$2,$3,$4)`,
        [dep.id, dep.user_id, dep.fee, `Deposit fee`]
      );
      await client.query(
        `INSERT INTO notifications (user_id, title, message, type) VALUES ($1,$2,$3,'success')`,
        [dep.user_id, 'Deposit Approved ✓', `Your deposit of $${dep.net_amount} has been credited to your account.`]
      );
    } else {
      await client.query(
        `INSERT INTO notifications (user_id, title, message, type) VALUES ($1,$2,$3,'error')`,
        [dep.user_id, 'Deposit Rejected', `Your deposit was rejected. ${admin_note || 'Contact support for more information.'}`]
      );
    }
    await client.query('COMMIT');
    res.json({ success: true });
  } catch(e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

/* ═══════════════════════════════════
   WITHDRAWALS
═══════════════════════════════════ */
router.get('/withdrawals', adminAuth, async (req, res) => {
  const { status } = req.query;
  const where  = status ? 'WHERE w.status=$1' : '';
  const params = status ? [status] : [];
  const r = await pool.query(
    `SELECT w.*, u.first_name, u.last_name, u.account_number, u.email
     FROM withdrawals w JOIN users u ON w.user_id=u.id
     ${where} ORDER BY w.created_at DESC LIMIT 100`,
    params
  );
  res.json({ withdrawals: r.rows });
});

router.put('/withdrawals/:id', adminAuth, async (req, res) => {
  const { status, admin_note } = req.body;
  if (!['approved','rejected'].includes(status)) return res.status(400).json({ error: 'Invalid status.' });

  const wdR = await pool.query('SELECT * FROM withdrawals WHERE id=$1', [req.params.id]);
  if (!wdR.rows.length) return res.status(404).json({ error: 'Withdrawal not found.' });
  const wd = wdR.rows[0];
  if (wd.status !== 'pending') return res.status(400).json({ error: 'Already processed.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE withdrawals SET status=$1, admin_note=$2 WHERE id=$3', [status, admin_note || null, wd.id]);

    if (status === 'approved') {
      await client.query(
        `INSERT INTO transactions (user_id, type, amount, fee, net_amount, description, status)
         VALUES ($1,'withdrawal',$2,$3,$4,$5,'completed')`,
        [wd.user_id, wd.amount, wd.fee, wd.net_amount, `Withdrawal to ${wd.bank_name}`]
      );
      await client.query(
        `INSERT INTO charge_account (source_type, source_id, user_id, amount, description)
         VALUES ('withdrawal',$1,$2,$3,$4)`,
        [wd.id, wd.user_id, wd.fee, `Withdrawal fee`]
      );
      await client.query(
        `INSERT INTO notifications (user_id, title, message, type) VALUES ($1,$2,$3,'success')`,
        [wd.user_id, 'Withdrawal Approved ✓', `Your withdrawal of $${wd.net_amount} to ${wd.bank_name} has been approved and processed.`]
      );
    } else {
      // Refund balance
      await client.query('UPDATE users SET balance_usd = balance_usd + $1 WHERE id=$2', [wd.amount, wd.user_id]);
      await client.query(
        `INSERT INTO notifications (user_id, title, message, type) VALUES ($1,$2,$3,'error')`,
        [wd.user_id, 'Withdrawal Rejected', `Your withdrawal of $${wd.amount} was rejected. Funds returned. ${admin_note || ''}`]
      );
    }
    await client.query('COMMIT');
    res.json({ success: true });
  } catch(e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

/* ═══════════════════════════════════
   TRANSACTIONS
═══════════════════════════════════ */
router.get('/transactions', adminAuth, async (req, res) => {
  const { type, limit = 100 } = req.query;
  const where  = type ? 'WHERE t.type=$1' : '';
  const params = type ? [type] : [];
  const r = await pool.query(
    `SELECT t.*,
            s.first_name||' '||s.last_name as sender_name,
            s.account_number as sender_account
     FROM transactions t
     LEFT JOIN users s ON t.user_id=s.id
     ${where} ORDER BY t.created_at DESC LIMIT ${parseInt(limit)}`,
    params
  );
  res.json({ transactions: r.rows });
});

/* ═══════════════════════════════════
   FEE LEDGER
═══════════════════════════════════ */
router.get('/charges', adminAuth, async (req, res) => {
  const r = await pool.query(
    `SELECT c.*, u.first_name||' '||u.last_name as user_name
     FROM charge_account c LEFT JOIN users u ON c.user_id=u.id
     ORDER BY c.created_at DESC LIMIT 200`
  );
  const total = await pool.query('SELECT COALESCE(SUM(amount),0) as total FROM charge_account');
  res.json({ charges: r.rows, total: parseFloat(total.rows[0].total) });
});

/* ═══════════════════════════════════
   KYC
═══════════════════════════════════ */
router.get('/kyc', adminAuth, async (req, res) => {
  const { status = 'pending' } = req.query;
  const r = await pool.query(
    `SELECT k.*, u.first_name, u.last_name, u.email, u.account_number, u.kyc_level
     FROM kyc_submissions k JOIN users u ON k.user_id=u.id
     WHERE k.status=$1 ORDER BY k.submitted_at DESC`,
    [status]
  );
  res.json({ submissions: r.rows });
});

router.put('/kyc/:id', adminAuth, async (req, res) => {
  const { status, admin_note } = req.body;
  if (!['approved','rejected'].includes(status)) return res.status(400).json({ error: 'Invalid status.' });

  const kycR = await pool.query('SELECT * FROM kyc_submissions WHERE id=$1', [req.params.id]);
  if (!kycR.rows.length) return res.status(404).json({ error: 'Submission not found.' });
  const kyc = kycR.rows[0];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'UPDATE kyc_submissions SET status=$1, admin_note=$2, reviewed_at=NOW() WHERE id=$3',
      [status, admin_note || null, kyc.id]
    );

    if (status === 'approved') {
      // Upgrade user KYC level if this is higher
      await client.query(
        'UPDATE users SET kyc_level = GREATEST(kyc_level, $1) WHERE id=$2',
        [kyc.level, kyc.user_id]
      );

      // If KYC 3 approved, generate virtual card
      if (kyc.level === 3) {
        const cardExists = await client.query('SELECT id FROM virtual_cards WHERE user_id=$1', [kyc.user_id]);
        if (!cardExists.rows.length) {
          const userR = await client.query('SELECT first_name, last_name FROM users WHERE id=$1', [kyc.user_id]);
          const u = userR.rows[0];
          const { generateCardNumber, generateCVV, getCardExpiry } = require('../utils/helpers');
          const cardNumber = generateCardNumber();
          const cvv = generateCVV();
          const { month, year } = getCardExpiry();
          await client.query(
            `INSERT INTO virtual_cards (user_id, card_number, card_holder, expiry_month, expiry_year, cvv, card_type)
             VALUES ($1,$2,$3,$4,$5,$6,'VISA')`,
            [kyc.user_id, cardNumber, `${u.first_name.toUpperCase()} ${u.last_name.toUpperCase()}`, month, year, cvv]
          );
        }
      }

      await client.query(
        `INSERT INTO notifications (user_id, title, message, type) VALUES ($1,$2,$3,'success')`,
        [kyc.user_id, `KYC Level ${kyc.level} Approved ✓`, `Your KYC Level ${kyc.level} verification has been approved! Your account limits have been upgraded.`]
      );
    } else {
      await client.query(
        `INSERT INTO notifications (user_id, title, message, type) VALUES ($1,$2,$3,'error')`,
        [kyc.user_id, `KYC Level ${kyc.level} Rejected`, `Your KYC Level ${kyc.level} was rejected. ${admin_note || 'Please resubmit with correct documents.'}`]
      );
    }

    await client.query('COMMIT');
    res.json({ success: true });
  } catch(e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

/* ═══════════════════════════════════
   LOANS
═══════════════════════════════════ */
router.get('/loans', adminAuth, async (req, res) => {
  const { status } = req.query;
  const where  = status ? 'WHERE l.status=$1' : '';
  const params = status ? [status] : [];
  const r = await pool.query(
    `SELECT l.*, u.first_name, u.last_name, u.email, u.account_number
     FROM loans l JOIN users u ON l.user_id=u.id
     ${where} ORDER BY l.created_at DESC`,
    params
  );
  res.json({ loans: r.rows });
});

router.put('/loans/:id', adminAuth, async (req, res) => {
  const { status, interest_rate, admin_note } = req.body;
  if (!['approved','rejected'].includes(status)) return res.status(400).json({ error: 'Invalid status.' });

  const loanR = await pool.query('SELECT * FROM loans WHERE id=$1', [req.params.id]);
  if (!loanR.rows.length) return res.status(404).json({ error: 'Loan not found.' });
  const loan = loanR.rows[0];
  if (loan.status !== 'pending') return res.status(400).json({ error: 'Loan already processed.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (status === 'approved') {
      const rate = parseFloat(interest_rate) || 5.0;
      const totalInterest   = parseFloat(loan.amount) * (rate / 100) * (loan.duration_months / 12);
      const totalRepayment  = parseFloat((parseFloat(loan.amount) + totalInterest).toFixed(2));
      const monthlyPayment  = parseFloat((totalRepayment / loan.duration_months).toFixed(2));

      await client.query(
        `UPDATE loans SET status='approved', interest_rate=$1, total_repayment=$2,
         monthly_payment=$3, admin_note=$4, approved_at=NOW() WHERE id=$5`,
        [rate, totalRepayment, monthlyPayment, admin_note || null, loan.id]
      );

      // Disburse loan amount to user
      await client.query('UPDATE users SET balance_usd = balance_usd + $1 WHERE id=$2', [loan.amount, loan.user_id]);

      await client.query(
        `INSERT INTO notifications (user_id, title, message, type) VALUES ($1,$2,$3,'success')`,
        [loan.user_id, 'Loan Approved ✓', `Your loan of $${parseFloat(loan.amount).toFixed(2)} has been approved and disbursed. Interest: ${rate}%, Total repayment: $${totalRepayment.toFixed(2)} over ${loan.duration_months} months.`]
      );
    } else {
      await client.query(
        "UPDATE loans SET status='rejected', admin_note=$1 WHERE id=$2",
        [admin_note || null, loan.id]
      );
      await client.query(
        `INSERT INTO notifications (user_id, title, message, type) VALUES ($1,$2,$3,'error')`,
        [loan.user_id, 'Loan Application Rejected', `Your loan application was not approved. ${admin_note || 'Contact support for more information.'}`]
      );
    }

    await client.query('COMMIT');
    res.json({ success: true });
  } catch(e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

router.get('/loans/:id/repayments', adminAuth, async (req, res) => {
  const r = await pool.query(
    `SELECT lr.*, u.first_name, u.last_name FROM loan_repayments lr
     JOIN users u ON lr.user_id=u.id WHERE lr.loan_id=$1 ORDER BY lr.created_at DESC`,
    [req.params.id]
  );
  res.json({ repayments: r.rows });
});

router.put('/loans/:id/repayment-confirm', adminAuth, async (req, res) => {
  const { amount, notes } = req.body;
  const loanR = await pool.query("SELECT * FROM loans WHERE id=$1 AND status='approved'", [req.params.id]);
  if (!loanR.rows.length) return res.status(404).json({ error: 'Active loan not found.' });
  const loan = loanR.rows[0];

  await pool.query('UPDATE loans SET amount_paid = amount_paid + $1 WHERE id=$2', [amount, loan.id]);
  await pool.query(
    'INSERT INTO loan_repayments (loan_id, user_id, amount, notes) VALUES ($1,$2,$3,$4)',
    [loan.id, loan.user_id, amount, notes || 'Admin confirmed repayment']
  );

  const newPaid = parseFloat(loan.amount_paid) + parseFloat(amount);
  if (newPaid >= parseFloat(loan.total_repayment)) {
    await pool.query("UPDATE loans SET status='completed' WHERE id=$1", [loan.id]);
  }

  await pool.query(
    `INSERT INTO notifications (user_id, title, message, type) VALUES ($1,$2,$3,'success')`,
    [loan.user_id, 'Repayment Confirmed', `Admin confirmed repayment of $${parseFloat(amount).toFixed(2)}.`]
  );

  res.json({ success: true });
});

/* ═══════════════════════════════════
   SAVINGS
═══════════════════════════════════ */
router.get('/savings', adminAuth, async (req, res) => {
  const r = await pool.query(
    `SELECT si.*, u.first_name, u.last_name, u.account_number, sp.name as plan_name
     FROM savings_investments si
     JOIN users u  ON si.user_id=u.id
     JOIN savings_plans sp ON si.plan_id=sp.id
     ORDER BY si.created_at DESC`
  );
  res.json({ investments: r.rows });
});

router.get('/savings/plans', adminAuth, async (req, res) => {
  const r = await pool.query('SELECT * FROM savings_plans ORDER BY duration_days');
  res.json({ plans: r.rows });
});

router.put('/savings/plans/:id', adminAuth, async (req, res) => {
  const { name, description, interest_rate, duration_days, minimum_amount, maximum_amount, is_active } = req.body;
  await pool.query(
    `UPDATE savings_plans SET name=COALESCE($1,name), description=COALESCE($2,description),
     interest_rate=COALESCE($3,interest_rate), duration_days=COALESCE($4,duration_days),
     minimum_amount=COALESCE($5,minimum_amount), maximum_amount=$6, is_active=COALESCE($7,is_active)
     WHERE id=$8`,
    [name, description, interest_rate, duration_days, minimum_amount, maximum_amount || null, is_active, req.params.id]
  );
  res.json({ success: true });
});

/* ═══════════════════════════════════
   CRYPTO
═══════════════════════════════════ */
router.get('/crypto', adminAuth, async (req, res) => {
  const r = await pool.query('SELECT * FROM crypto_prices ORDER BY id');
  res.json({ coins: r.rows });
});

router.put('/crypto/:symbol', adminAuth, async (req, res) => {
  const { price, change_24h, market_trend } = req.body;
  await pool.query(
    'UPDATE crypto_prices SET price=$1, change_24h=$2, market_trend=$3, updated_at=NOW() WHERE symbol=$4',
    [price, change_24h, market_trend, req.params.symbol.toUpperCase()]
  );
  res.json({ success: true });
});

/* ═══════════════════════════════════
   CHAT
═══════════════════════════════════ */
router.get('/chat/conversations', adminAuth, async (req, res) => {
  const r = await pool.query(
    `SELECT u.id, u.first_name, u.last_name, u.username, u.account_number,
            (SELECT message FROM chat_messages WHERE user_id=u.id ORDER BY created_at DESC LIMIT 1) as last_msg,
            (SELECT created_at FROM chat_messages WHERE user_id=u.id ORDER BY created_at DESC LIMIT 1) as last_time,
            (SELECT COUNT(*) FROM chat_messages WHERE user_id=u.id AND sender_type='user' AND is_read=FALSE) as unread
     FROM users u
     WHERE EXISTS (SELECT 1 FROM chat_messages WHERE user_id=u.id)
     ORDER BY last_time DESC NULLS LAST`
  );
  res.json({ conversations: r.rows });
});

router.get('/chat/messages/:userId', adminAuth, async (req, res) => {
  const r = await pool.query(
    'SELECT * FROM chat_messages WHERE user_id=$1 ORDER BY created_at ASC',
    [req.params.userId]
  );
  await pool.query(
    "UPDATE chat_messages SET is_read=TRUE WHERE user_id=$1 AND sender_type='user' AND is_read=FALSE",
    [req.params.userId]
  );
  res.json({ messages: r.rows });
});

router.post('/chat/messages/:userId', adminAuth, async (req, res) => {
  const { message, message_type = 'text' } = req.body;
  if (!message) return res.status(400).json({ error: 'Message required.' });
  const r = await pool.query(
    `INSERT INTO chat_messages (user_id, sender_type, message, message_type)
     VALUES ($1,'admin',$2,$3) RETURNING *`,
    [req.params.userId, message, message_type]
  );
  res.status(201).json({ message: r.rows[0] });
});

router.post('/chat/generate-code/:userId/:type', adminAuth, async (req, res) => {
  const { userId, type } = req.params;
  if (!['withdrawal_token','winner_code','state_pin'].includes(type)) {
    return res.status(400).json({ error: 'Invalid code type.' });
  }

  const code = generateWithdrawalCode(type);
  const labels = { withdrawal_token:'🔐 Withdrawal Token', winner_code:'🏆 Winner Code', state_pin:'📍 State Pin' };

  await pool.query(
    'INSERT INTO withdrawal_codes (user_id, code_type, code_value, is_used) VALUES ($1,$2,$3,FALSE)',
    [userId, type, code]
  );

  const msg = `${labels[type]}\n\nYour code: ${code}\n\nThis code is single-use only. Do not share it with anyone.`;
  await pool.query(
    `INSERT INTO chat_messages (user_id, sender_type, message, message_type) VALUES ($1,'admin',$2,'code')`,
    [userId, msg]
  );

  res.json({ success: true, code });
});

router.get('/chat/unread-total', adminAuth, async (req, res) => {
  const r = await pool.query(
    "SELECT COUNT(*) FROM chat_messages WHERE sender_type='user' AND is_read=FALSE"
  );
  res.json({ unread: parseInt(r.rows[0].count) });
});

/* ═══════════════════════════════════
   BROADCAST
═══════════════════════════════════ */
router.post('/broadcast', adminAuth, async (req, res) => {
  const { title, message } = req.body;
  if (!title || !message) return res.status(400).json({ error: 'Title and message required.' });

  const usersR = await pool.query('SELECT id FROM users WHERE status=$1', ['active']);
  const users  = usersR.rows;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const u of users) {
      await client.query(
        `INSERT INTO notifications (user_id, title, message, type) VALUES ($1,$2,$3,'info')`,
        [u.id, title, message]
      );
    }
    await client.query(
      'INSERT INTO broadcasts (title, message, sent_to) VALUES ($1,$2,$3)',
      [title, message, users.length]
    );
    await client.query('COMMIT');
    res.json({ success: true, sent_to: users.length });
  } catch(e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

router.get('/broadcasts', adminAuth, async (req, res) => {
  const r = await pool.query('SELECT * FROM broadcasts ORDER BY created_at DESC LIMIT 50');
  res.json({ broadcasts: r.rows });
});

module.exports = router;
