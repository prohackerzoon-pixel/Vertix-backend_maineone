const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { pool } = require('../database/db');
const { sign } = require('../middleware/adminAuth');

router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required.' });

  const r = await pool.query('SELECT * FROM admin_users WHERE username=$1', [username]);
  if (!r.rows.length) return res.status(401).json({ error: 'Invalid credentials.' });

  const valid = await bcrypt.compare(password, r.rows[0].password_hash);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials.' });

  const token = sign({ id: r.rows[0].id, username: r.rows[0].username, role: 'admin' });
  res.json({ token, admin: { id: r.rows[0].id, username: r.rows[0].username } });
});

module.exports = router;
