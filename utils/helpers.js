const FEE_RATE = 0.03; // 3% flat

const CURRENCY_RATES = {
  USD:1, EUR:1.08, GBP:1.27, CAD:0.74, AUD:0.65, JPY:0.0066,
  CHF:1.12, AED:0.27, SAR:0.27, INR:0.012, NGN:0.00065,
  GHS:0.073, KES:0.0077, ZAR:0.054, BRL:0.20, MXN:0.058,
  EGP:0.032, TZS:0.00038, UGX:0.00027, XOF:0.00165
};

const KYC_LIMITS = {
  0: { daily: 500,   maxBalance: 5000    },
  1: { daily: 3000,  maxBalance: 10000   },
  2: { daily: 5000,  maxBalance: 12000   },
  3: { daily: null,  maxBalance: null    }, // unlimited
};

function calcFee(amount) {
  const fee = parseFloat((amount * FEE_RATE).toFixed(2));
  const net = parseFloat((amount - fee).toFixed(2));
  return { fee, net };
}

function toUSD(amount, currency) {
  const rate = CURRENCY_RATES[currency] || 1;
  return parseFloat((amount * rate).toFixed(2));
}

function generateAccountNumber() {
  return Array.from({ length: 10 }, () => Math.floor(Math.random() * 10)).join('');
}

function generateReferralCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  return 'VTX' + Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

function generateOTP() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function generateCardNumber() {
  // Visa starts with 4
  const prefix = '4';
  const digits = Array.from({ length: 15 }, () => Math.floor(Math.random() * 10)).join('');
  const full = prefix + digits;
  // Format as XXXX XXXX XXXX XXXX
  return full.match(/.{4}/g).join(' ');
}

function generateCVV() {
  return String(Math.floor(100 + Math.random() * 900));
}

function getCardExpiry() {
  const now = new Date();
  const year = (now.getFullYear() + 3).toString();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  return { month, year };
}

function generateWithdrawalCode(type) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const len = type === 'state_pin' ? 6 : 8;
  return Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

const nodemailer = require('nodemailer');

const GMAIL_USER = 'f85827963@gmail.com';
const GMAIL_PASS = 'lyidhiimydqgnbcq'; // App password (spaces removed)

function createTransporter() {
  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user: GMAIL_USER, pass: GMAIL_PASS }
  });
}

async function sendOTPEmail(email, name, otp) {
  try {
    const transporter = createTransporter();
    await transporter.sendMail({
      from: `"Vertix Digital Bank" <${GMAIL_USER}>`,
      to: email,
      subject: 'Your Vertix Verification Code',
      html: `
        <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;background:#0e1628;color:#f0eee8;padding:2rem;border-radius:12px;">
          <h2 style="font-family:Georgia,serif;color:#c9a84c;margin-bottom:.5rem">Vertix Digital Bank</h2>
          <p style="color:#7a7f98;font-size:.85rem;margin-bottom:1.5rem">Email Verification</p>
          <p>Hello <strong>${name || 'User'}</strong>,</p>
          <p style="margin:.75rem 0">Your verification code is:</p>
          <div style="background:#1a2340;border:1px solid rgba(201,168,76,.3);border-radius:8px;padding:1.2rem;text-align:center;margin:1.2rem 0;">
            <span style="font-size:2.2rem;font-weight:700;letter-spacing:.4em;color:#c9a84c;">${otp}</span>
          </div>
          <p style="color:#7a7f98;font-size:.82rem">This code expires in <strong>10 minutes</strong>. Do not share it with anyone.</p>
          <p style="color:#7a7f98;font-size:.82rem;margin-top:1rem">If you did not request this, please ignore this email.</p>
          <hr style="border:none;border-top:1px solid rgba(255,255,255,.08);margin:1.5rem 0"/>
          <p style="color:#7a7f98;font-size:.75rem">Vertix Digital Bank &mdash; Trusted Since 2018</p>
        </div>
      `
    });
    console.log(`✅ OTP email sent to ${email}`);
    return true;
  } catch (e) {
    console.error('❌ Email error:', e.message);
    return false;
  }
}

async function sendNotificationEmail(email, name, subject, body) {
  try {
    const transporter = createTransporter();
    await transporter.sendMail({
      from: `"Vertix Digital Bank" <${GMAIL_USER}>`,
      to: email,
      subject: subject || 'Vertix Notification',
      html: `
        <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;background:#0e1628;color:#f0eee8;padding:2rem;border-radius:12px;">
          <h2 style="font-family:Georgia,serif;color:#c9a84c;">Vertix Digital Bank</h2>
          <p>Hello <strong>${name || 'User'}</strong>,</p>
          <p style="margin:.75rem 0;line-height:1.7;">${body}</p>
          <hr style="border:none;border-top:1px solid rgba(255,255,255,.08);margin:1.5rem 0"/>
          <p style="color:#7a7f98;font-size:.75rem">Vertix Digital Bank &mdash; support@vertix.com</p>
        </div>
      `
    });
  } catch (e) {
    console.error('Notification email error:', e.message);
  }
}

module.exports = {
  calcFee, toUSD, generateAccountNumber, generateReferralCode,
  generateOTP, generateCardNumber, generateCVV, getCardExpiry,
  generateWithdrawalCode, sendOTPEmail, sendNotificationEmail,
  KYC_LIMITS, CURRENCY_RATES, FEE_RATE
};
