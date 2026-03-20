const { Pool } = require('pg');
const bcrypt   = require('bcryptjs');

const pool = new Pool({
  connectionString: 'postgresql://postgres.bnrevvoijgwwszlnqaoo:jhf88sMzTa6InNbH@aws-1-eu-central-1.pooler.supabase.com:6543/postgres',
  ssl: { rejectUnauthorized: false }
});

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id               SERIAL PRIMARY KEY,
  first_name       VARCHAR(100) NOT NULL,
  last_name        VARCHAR(100) NOT NULL,
  email            VARCHAR(255) UNIQUE NOT NULL,
  username         VARCHAR(100) UNIQUE NOT NULL,
  phone            VARCHAR(50),
  country          VARCHAR(100),
  password_hash    VARCHAR(255) NOT NULL,
  balance_usd      DECIMAL(15,2) DEFAULT 0,
  account_number   VARCHAR(20) UNIQUE NOT NULL,
  profile_photo    TEXT,
  transaction_pin  VARCHAR(255),
  kyc_level        INTEGER DEFAULT 0,
  referral_code    VARCHAR(20) UNIQUE,
  referred_by      VARCHAR(20),
  email_verified   BOOLEAN DEFAULT FALSE,
  status           VARCHAR(20) DEFAULT 'active',
  created_at       TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS admin_users (
  id            SERIAL PRIMARY KEY,
  username      VARCHAR(100) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  created_at    TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS otp_codes (
  id         SERIAL PRIMARY KEY,
  email      VARCHAR(255) NOT NULL,
  code       VARCHAR(10) NOT NULL,
  type       VARCHAR(50) DEFAULT 'email_verification',
  expires_at TIMESTAMP NOT NULL,
  used       BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS transactions (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER REFERENCES users(id),
  type        VARCHAR(50) NOT NULL,
  amount      DECIMAL(15,2) NOT NULL,
  fee         DECIMAL(15,2) DEFAULT 0,
  net_amount  DECIMAL(15,2) NOT NULL,
  description TEXT,
  status      VARCHAR(20) DEFAULT 'completed',
  reference   VARCHAR(100),
  created_at  TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS deposits (
  id              SERIAL PRIMARY KEY,
  user_id         INTEGER REFERENCES users(id),
  amount_original DECIMAL(15,2) NOT NULL,
  currency        VARCHAR(10) DEFAULT 'USD',
  amount_usd      DECIMAL(15,2) NOT NULL,
  fee             DECIMAL(15,2) NOT NULL,
  net_amount      DECIMAL(15,2) NOT NULL,
  payment_method  VARCHAR(50),
  reference       VARCHAR(255),
  status          VARCHAR(20) DEFAULT 'pending',
  admin_note      TEXT,
  created_at      TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS transfers (
  id           SERIAL PRIMARY KEY,
  sender_id    INTEGER REFERENCES users(id),
  recipient_id INTEGER REFERENCES users(id),
  amount       DECIMAL(15,2) NOT NULL,
  fee          DECIMAL(15,2) NOT NULL,
  net_amount   DECIMAL(15,2) NOT NULL,
  description  TEXT,
  status       VARCHAR(20) DEFAULT 'completed',
  created_at   TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS withdrawals (
  id                  SERIAL PRIMARY KEY,
  user_id             INTEGER REFERENCES users(id),
  amount              DECIMAL(15,2) NOT NULL,
  fee                 DECIMAL(15,2) NOT NULL,
  net_amount          DECIMAL(15,2) NOT NULL,
  bank_name           VARCHAR(255),
  bank_account_number VARCHAR(255),
  account_name        VARCHAR(255),
  status              VARCHAR(20) DEFAULT 'pending',
  admin_note          TEXT,
  created_at          TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS notifications (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER REFERENCES users(id),
  title      VARCHAR(255) NOT NULL,
  message    TEXT NOT NULL,
  type       VARCHAR(50) DEFAULT 'info',
  is_read    BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS crypto_prices (
  id           SERIAL PRIMARY KEY,
  symbol       VARCHAR(20) UNIQUE NOT NULL,
  coin_name    VARCHAR(100) NOT NULL,
  price        DECIMAL(15,2) NOT NULL,
  change_24h   DECIMAL(8,2) DEFAULT 0,
  market_trend VARCHAR(20) DEFAULT 'neutral',
  updated_at   TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS charge_account (
  id          SERIAL PRIMARY KEY,
  source_type VARCHAR(50) NOT NULL,
  source_id   INTEGER,
  user_id     INTEGER REFERENCES users(id),
  amount      DECIMAL(15,2) NOT NULL,
  description TEXT,
  created_at  TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER REFERENCES users(id),
  sender_type  VARCHAR(20) NOT NULL,
  message      TEXT,
  message_type VARCHAR(20) DEFAULT 'text',
  file_data    TEXT,
  is_read      BOOLEAN DEFAULT FALSE,
  created_at   TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS withdrawal_codes (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER REFERENCES users(id),
  code_type  VARCHAR(50) NOT NULL,
  code_value VARCHAR(20) NOT NULL,
  is_used    BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS kyc_submissions (
  id               SERIAL PRIMARY KEY,
  user_id          INTEGER REFERENCES users(id),
  level            INTEGER NOT NULL,
  house_address    TEXT,
  city             VARCHAR(100),
  state            VARCHAR(100),
  zip_code         VARCHAR(20),
  country          VARCHAR(100),
  date_of_birth    VARCHAR(20),
  nationality      VARCHAR(100),
  document_type    VARCHAR(50),
  document_number  VARCHAR(100),
  document_front   TEXT,
  document_back    TEXT,
  card_holder_name VARCHAR(200),
  card_last_four   VARCHAR(4),
  card_type        VARCHAR(20),
  status           VARCHAR(20) DEFAULT 'pending',
  admin_note       TEXT,
  submitted_at     TIMESTAMP DEFAULT NOW(),
  reviewed_at      TIMESTAMP
);

CREATE TABLE IF NOT EXISTS virtual_cards (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER REFERENCES users(id) UNIQUE,
  card_number   VARCHAR(20) NOT NULL,
  card_holder   VARCHAR(200) NOT NULL,
  expiry_month  VARCHAR(2) NOT NULL,
  expiry_year   VARCHAR(4) NOT NULL,
  cvv           VARCHAR(4) NOT NULL,
  card_type     VARCHAR(20) DEFAULT 'VISA',
  status        VARCHAR(20) DEFAULT 'active',
  created_at    TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS savings_plans (
  id             SERIAL PRIMARY KEY,
  name           VARCHAR(200) NOT NULL,
  description    TEXT,
  interest_rate  DECIMAL(5,2) NOT NULL,
  duration_days  INTEGER NOT NULL,
  minimum_amount DECIMAL(15,2) DEFAULT 100,
  maximum_amount DECIMAL(15,2),
  is_active      BOOLEAN DEFAULT TRUE,
  created_at     TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS savings_investments (
  id              SERIAL PRIMARY KEY,
  user_id         INTEGER REFERENCES users(id),
  plan_id         INTEGER REFERENCES savings_plans(id),
  amount          DECIMAL(15,2) NOT NULL,
  interest_rate   DECIMAL(5,2) NOT NULL,
  expected_return DECIMAL(15,2) NOT NULL,
  start_date      TIMESTAMP DEFAULT NOW(),
  maturity_date   TIMESTAMP NOT NULL,
  status          VARCHAR(20) DEFAULT 'active',
  actual_return   DECIMAL(15,2),
  created_at      TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS loans (
  id               SERIAL PRIMARY KEY,
  user_id          INTEGER REFERENCES users(id),
  amount           DECIMAL(15,2) NOT NULL,
  reason           TEXT,
  duration_months  INTEGER NOT NULL,
  interest_rate    DECIMAL(5,2),
  monthly_payment  DECIMAL(15,2),
  total_repayment  DECIMAL(15,2),
  amount_paid      DECIMAL(15,2) DEFAULT 0,
  status           VARCHAR(20) DEFAULT 'pending',
  admin_note       TEXT,
  approved_at      TIMESTAMP,
  created_at       TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS loan_repayments (
  id         SERIAL PRIMARY KEY,
  loan_id    INTEGER REFERENCES loans(id),
  user_id    INTEGER REFERENCES users(id),
  amount     DECIMAL(15,2) NOT NULL,
  notes      TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS broadcasts (
  id         SERIAL PRIMARY KEY,
  title      VARCHAR(255) NOT NULL,
  message    TEXT NOT NULL,
  sent_to    INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS withdrawal_sessions (
  id                    SERIAL PRIMARY KEY,
  user_id               INTEGER REFERENCES users(id) UNIQUE,
  step                  INTEGER DEFAULT 1,
  amount                DECIMAL(15,2),
  bank_name             VARCHAR(255),
  bank_account_number   VARCHAR(255),
  account_name          VARCHAR(255),
  token_verified        BOOLEAN DEFAULT FALSE,
  winner_verified       BOOLEAN DEFAULT FALSE,
  pin_verified          BOOLEAN DEFAULT FALSE,
  created_at            TIMESTAMP DEFAULT NOW(),
  updated_at            TIMESTAMP DEFAULT NOW()
);
`;

const COINS = [
  { symbol:'BTC',  coin_name:'Bitcoin',  price:67420.00, change_24h:2.34,  trend:'bullish' },
  { symbol:'ETH',  coin_name:'Ethereum', price:3520.50,  change_24h:1.87,  trend:'bullish' },
  { symbol:'SOL',  coin_name:'Solana',   price:182.30,   change_24h:-0.92, trend:'neutral' },
  { symbol:'BNB',  coin_name:'BNB',      price:598.40,   change_24h:0.65,  trend:'neutral' },
  { symbol:'ADA',  coin_name:'Cardano',  price:0.58,     change_24h:-1.23, trend:'bearish' },
  { symbol:'USDT', coin_name:'Tether',   price:1.00,     change_24h:0.01,  trend:'neutral' },
  { symbol:'XRP',  coin_name:'XRP',      price:0.62,     change_24h:3.14,  trend:'bullish' },
  { symbol:'DOGE', coin_name:'Dogecoin', price:0.18,     change_24h:-2.10, trend:'bearish' },
  { symbol:'MATIC',coin_name:'Polygon',  price:0.92,     change_24h:1.05,  trend:'neutral' },
  { symbol:'LTC',  coin_name:'Litecoin', price:85.40,    change_24h:0.78,  trend:'neutral' },
];

const SAVINGS_PLANS = [
  { name:'Basic Savings',   description:'Safe short-term savings with steady returns.',       interest_rate:5.0,  duration_days:30,  minimum_amount:100,   maximum_amount:10000  },
  { name:'Growth Plan',     description:'Medium-term plan with higher interest returns.',     interest_rate:8.5,  duration_days:60,  minimum_amount:500,   maximum_amount:50000  },
  { name:'Premium Plan',    description:'High-yield long-term investment for serious savers.',interest_rate:12.0, duration_days:90,  minimum_amount:1000,  maximum_amount:null   },
];

async function seedData(client) {
  // Admin
  const adminExists = await client.query('SELECT id FROM admin_users WHERE username = $1', ['admin1']);
  if (adminExists.rows.length === 0) {
    const hash = await bcrypt.hash('Admin@Vertix1', 10);
    await client.query('INSERT INTO admin_users (username, password_hash) VALUES ($1, $2)', ['admin1', hash]);
    console.log('✅ Admin seeded');
  }

  // Crypto
  for (const c of COINS) {
    await client.query(
      `INSERT INTO crypto_prices (symbol, coin_name, price, change_24h, market_trend)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (symbol) DO NOTHING`,
      [c.symbol, c.coin_name, c.price, c.change_24h, c.trend]
    );
  }

  // Savings plans
  for (const p of SAVINGS_PLANS) {
    const exists = await client.query('SELECT id FROM savings_plans WHERE name = $1', [p.name]);
    if (exists.rows.length === 0) {
      await client.query(
        `INSERT INTO savings_plans (name, description, interest_rate, duration_days, minimum_amount, maximum_amount)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [p.name, p.description, p.interest_rate, p.duration_days, p.minimum_amount, p.maximum_amount]
      );
    }
  }
  console.log('✅ Seed data ready');
}

async function initDb() {
  const client = await pool.connect();
  try {
    await client.query(SCHEMA);
    await seedData(client);
    console.log('✅ Database initialized');
  } finally {
    client.release();
  }
}

module.exports = { pool, initDb };
