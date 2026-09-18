const express      = require('express');
const cors         = require('cors');
const cookieParser = require('cookie-parser');
const path         = require('path');
require('dotenv').config();

const app  = express();
const PORT = process.env.PORT || 4000;

// ─── Global middleware ─────────────────────────────────────────────────
const allowedOrigin = process.env.CORS_ORIGIN || process.env.APP_BASE_URL;
app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (
      !allowedOrigin ||
      origin === allowedOrigin ||
      origin.endsWith('.vercel.app') ||
      origin.includes('localhost') ||
      origin.includes('127.0.0.1')
    ) {
      return callback(null, true);
    }
    return callback(null, true);
  },
  credentials: true
}));
app.use('/api/bank/webhook', express.raw({type: 'application/json'}), require('./middlewares/stripeWebhook').verifyStripeWebhook, require('./routes/bank').webhookHandler);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ─── Static files ──────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ─── API routes ────────────────────────────────────────────────────────
app.use('/api/auth',     require('./routes/auth'));
app.use('/api/accounts', require('./routes/accounts'));
app.use('/api/goals',    require('./routes/accounts').goalsRouter);
app.use('/api/bills',    require('./routes/accounts').billsRouter);
app.use('/api/tickets',  require('./routes/accounts').ticketsRouter);
app.use('/api/bank',     require('./routes/bank'));
app.use('/api/admin',    require('./routes/admin'));

// ─── Page routes ───────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get(['/app', '/login', '/signup'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'app.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin', 'index.html'));
});

// ─── Global error handler ──────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Unhandled Server Error:', err);
  res.status(500).json({ success: false, message: 'Internal Server Error' });
});

// ─── Start ─────────────────────────────────────────────────────────────
if (require.main === module && !process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log('=================================================');
    console.log(`Olith Banking Server running at http://localhost:${PORT}`);
    console.log(`Admin console at http://localhost:${PORT}/admin`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log('=================================================');
  });
}

module.exports = app;
