const router  = require('express').Router();
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const { pool } = require('../database/db');
const { sign } = require('../middleware/auth');
const {
  generateAccountNumber, generateReferralCode,
  generateOTP, sendOTPEmail
} = require('../utils/helpers');

const OTP_JWT_SECRET = 'vertix_otp_verified_secret_2025';

/* ── POST /api/auth/send-otp ────────────────────── */
router.post('/send-otp', async (req, res) => {
  const { email, first_name } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required' });

  // Check if email already taken
  const exists = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
  if (exists.rows.length > 0) return res.status(400).json({ error: 'Email already registered' });

  const otp = generateOTP();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 min

  // Invalidate old OTPs for this email
  await pool.query("UPDATE otp_codes SET used = TRUE WHERE email = $1 AND used = FALSE", [email.toLowerCase()]);

  await pool.query(
    'INSERT INTO otp_codes (email, code, type, expires_at) VALUES ($1, $2, $3, $4)',
    [email.toLowerCase(), otp, 'email_verification', expiresAt]
  );

  // Send email via Nodemailer + Gmail from backend
  const sent = await sendOTPEmail(email, first_name || 'User', otp);
  if (!sent) console.log('OTP for ' + email + ': ' + otp);

  res.json({ success: true, message: 'Verification code sent to your email' });
});

/* ── POST /api/auth/verify-otp ──────────────────── */
router.post('/verify-otp', async (req, res) => {
  const { email, code } = req.body;
  if (!email || !code) return res.status(400).json({ error: 'Email and code required' });

  const result = await pool.query(
    `SELECT id FROM otp_codes
     WHERE email = $1 AND code = $2 AND used = FALSE AND expires_at > NOW()
     ORDER BY created_at DESC LIMIT 1`,
    [email.toLowerCase(), code]
  );

  if (result.rows.length === 0) {
    return res.status(400).json({ error: 'Invalid or expired code. Please request a new one.' });
  }

  // Mark as used
  await pool.query('UPDATE otp_codes SET used = TRUE WHERE id = $1', [result.rows[0].id]);

  // Issue a short-lived token proving OTP was verified
  const otpToken = jwt.sign({ email: email.toLowerCase(), verified: true }, OTP_JWT_SECRET, { expiresIn: '15m' });

  res.json({ success: true, otp_token: otpToken });
});

/* ── POST /api/auth/signup ──────────────────────── */
router.post('/signup', async (req, res) => {
  const { first_name, last_name, email, username, phone, country, password, confirm_password, otp_token, referral_code } = req.body;

  // Validate OTP token
  try {
    const decoded = jwt.verify(otp_token, OTP_JWT_SECRET);
    if (decoded.email !== email.toLowerCase()) {
      return res.status(400).json({ error: 'Email verification mismatch. Please verify your email again.' });
    }
  } catch (e) {
    return res.status(400).json({ error: 'Email not verified. Please complete verification.' });
  }

  if (!first_name || !last_name || !email || !username || !password) {
    return res.status(400).json({ error: 'All required fields must be filled.' });
  }
  if (password !== confirm_password) return res.status(400).json({ error: 'Passwords do not match.' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });

  // Check duplicates
  const dupEmail = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
  if (dupEmail.rows.length > 0) return res.status(400).json({ error: 'Email already registered.' });

  const dupUser = await pool.query('SELECT id FROM users WHERE username = $1', [username.toLowerCase()]);
  if (dupUser.rows.length > 0) return res.status(400).json({ error: 'Username already taken.' });

  // Check referral
  let referredById = null;
  if (referral_code) {
    const ref = await pool.query('SELECT id FROM users WHERE referral_code = $1', [referral_code.toUpperCase()]);
    if (ref.rows.length > 0) referredById = ref.rows[0].id;
  }

  const passwordHash   = await bcrypt.hash(password, 10);
  const accountNumber  = generateAccountNumber();
  const myReferralCode = generateReferralCode();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const newUser = await client.query(
      `INSERT INTO users
        (first_name, last_name, email, username, phone, country, password_hash, account_number, referral_code, referred_by, email_verified)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,TRUE)
       RETURNING id, first_name, last_name, email, username, account_number, balance_usd, kyc_level, status`,
      [first_name.trim(), last_name.trim(), email.toLowerCase(), username.toLowerCase(),
       phone || null, country || null, passwordHash, accountNumber, myReferralCode,
       referral_code ? referral_code.toUpperCase() : null]
    );

    const user = newUser.rows[0];

    // Referral bonus - $10 to referrer, $5 to new user
    if (referredById) {
      await client.query('UPDATE users SET balance_usd = balance_usd + 10 WHERE id = $1', [referredById]);
      await client.query('UPDATE users SET balance_usd = balance_usd + 5 WHERE id = $1', [user.id]);
      await client.query(
        `INSERT INTO notifications (user_id, title, message, type) VALUES ($1,$2,$3,$4)`,
        [referredById, 'Referral Bonus!', `You earned $10 because someone used your referral code. Balance updated.`, 'success']
      );
      await client.query(
        `INSERT INTO notifications (user_id, title, message, type) VALUES ($1,$2,$3,$4)`,
        [user.id, 'Welcome Bonus!', `You received a $5 welcome bonus for using a referral code.`, 'success']
      );
    }

    // Welcome notification
    await client.query(
      `INSERT INTO notifications (user_id, title, message, type) VALUES ($1,$2,$3,$4)`,
      [user.id, 'Welcome to Vertix!', `Your account has been created successfully. Account number: ${accountNumber}. Complete KYC to unlock higher limits.`, 'info']
    );

    await client.query('COMMIT');

    const token = sign({ id: user.id, email: user.email });
    res.status(201).json({ token, user });

  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Signup error:', e.message);
    res.status(500).json({ error: 'Registration failed. Please try again.' });
  } finally {
    client.release();
  }
});

/* ── POST /api/auth/login ───────────────────────── */
router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required.' });

  const result = await pool.query(
    'SELECT * FROM users WHERE username = $1 OR email = $1',
    [username.toLowerCase()]
  );

  if (result.rows.length === 0) return res.status(401).json({ error: 'Invalid credentials.' });

  const user = result.rows[0];
  if (user.status === 'frozen') return res.status(403).json({ error: 'Your account has been frozen. Contact support.' });

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials.' });

  const token = sign({ id: user.id, email: user.email });
  const { password_hash, transaction_pin, ...safeUser } = user;
  res.json({ token, user: safeUser });
});

module.exports = router;
