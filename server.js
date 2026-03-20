const express = require('express');
const cors    = require('cors');
const { initDb } = require('./database/db');

const app = express();
app.use(cors());
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

app.use('/api/auth',          require('./routes/auth'));
app.use('/api/users',         require('./routes/users'));
app.use('/api/deposits',      require('./routes/deposits'));
app.use('/api/transfers',     require('./routes/transfers'));
app.use('/api/withdrawals',   require('./routes/withdrawals'));
app.use('/api/transactions',  require('./routes/transactions'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/crypto',        require('./routes/crypto'));
app.use('/api/chat',          require('./routes/chat'));
app.use('/api/kyc',           require('./routes/kyc'));
app.use('/api/cards',         require('./routes/cards'));
app.use('/api/savings',       require('./routes/savings'));
app.use('/api/loans',         require('./routes/loans'));
app.use('/api/admin/auth',    require('./routes/adminAuth'));
app.use('/api/admin',         require('./routes/admin'));

app.get('/', (req, res) => res.json({ status: 'Vertix v2 running', version: '2.0.0' }));

const PORT = process.env.PORT || 5000;

initDb().then(() => {
  app.listen(PORT, () => console.log(`✅ Vertix v2 running on port ${PORT}`));
}).catch(err => {
  console.error('❌ DB init failed:', err.message);
  process.exit(1);
});
