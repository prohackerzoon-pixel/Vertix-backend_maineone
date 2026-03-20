const jwt = require('jsonwebtoken');
const JWT_SECRET = 'vertix_v2_user_jwt_secret_2025_secure';

module.exports = (req, res, next) => {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    req.user = jwt.verify(auth.split(' ')[1], JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
};

module.exports.JWT_SECRET = JWT_SECRET;
module.exports.sign = (payload) => jwt.sign(payload, JWT_SECRET, { expiresIn: '30d' });
