const jwt = require('jsonwebtoken');
const ADMIN_JWT_SECRET = 'vertix_v2_admin_jwt_secret_2025_secure';

module.exports = (req, res, next) => {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Admin unauthorized' });
  }
  try {
    req.admin = jwt.verify(auth.split(' ')[1], ADMIN_JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid admin token' });
  }
};

module.exports.ADMIN_JWT_SECRET = ADMIN_JWT_SECRET;
module.exports.sign = (payload) => jwt.sign(payload, ADMIN_JWT_SECRET, { expiresIn: '12h' });
