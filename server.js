/**
 * Free Pentecostal Churches of Kenya (FPCK) — full-stack website server
 * ---------------------------------------------------------------------
 * Files:  index.html  +  style.css  +  server.js   (keep all three in one folder)
 *
 * ======================================================================
 * SETUP (local)
 * ======================================================================
 * 1. Install Node.js 18 or newer (https://nodejs.org). Check with: node -v
 *
 * 2. In this folder run:
 *      npm init -y
 *      npm install express better-sqlite3 multer bcryptjs jsonwebtoken helmet express-rate-limit dotenv
 *
 * 3. Create a file named  .env  in this folder (never commit it, never share it):
 *
 *      PORT=3000
 *      NODE_ENV=development
 *      # Generate with: node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
 *      JWT_SECRET=paste_a_long_random_string_here_at_least_32_characters
 *
 *      # First administrator (created only when no admin exists yet).
 *      # Use a strong password (12+ characters). Remove ADMIN_PASSWORD from .env afterwards.
 *      ADMIN_USERNAME=admin
 *      ADMIN_PASSWORD=choose-a-long-unique-password
 *
 *      # Google Maps (optional). Browser key restricted to your domain — see "Google Maps" below.
 *      GOOGLE_MAPS_EMBED_KEY=
 *
 *      # M-Pesa Daraja (see "M-Pesa" below)
 *      MPESA_ENV=sandbox                  # sandbox | production
 *      MPESA_CONSUMER_KEY=
 *      MPESA_CONSUMER_SECRET=
 *      MPESA_SHORTCODE=174379             # sandbox shortcode; use your Paybill/Till in production
 *      MPESA_PASSKEY=                     # sandbox passkey from the Daraja "Simulate" page
 *      MPESA_TRANSACTION_TYPE=CustomerPayBillOnline   # or CustomerBuyGoodsOnline for a Till number
 *      MPESA_CALLBACK_BASE_URL=https://your-public-https-url   # no trailing slash
 *      MPESA_CALLBACK_SECRET=another_long_random_string_20_chars_min
 *      MIN_DONATION=1                     # use 10 or more in production
 *
 *      # Behind a proxy/load balancer (Nginx, Render, Railway…)? set to 1
 *      TRUST_PROXY=0
 *
 * 4. Start:   node server.js        then open  http://localhost:3000
 *    (Optional: add  "start": "node server.js"  under "scripts" in package.json and run npm start.)
 *
 * ======================================================================
 * GOOGLE MAPS
 * ======================================================================
 * The church pages show a Google Map without any key (keyless embed). For the official
 * Maps Embed API (recommended for production):
 *   1. Google Cloud Console → create/select a project → enable "Maps Embed API".
 *   2. Credentials → Create API key → restrict it to "HTTP referrers" (your domain)
 *      and to the "Maps Embed API" only.
 *   3. Put it in GOOGLE_MAPS_EMBED_KEY. This key is meant for browsers, so it is safe to
 *      expose ONLY because it is restricted. Never reuse an unrestricted key here.
 *
 * ======================================================================
 * M-PESA DARAJA (SANDBOX TESTING)
 * ======================================================================
 *   1. Create an account at https://developer.safaricom.co.ke and add an app with the
 *      "Lipa Na M-Pesa Sandbox" product enabled. Copy the Consumer Key and Secret.
 *   2. In the portal's STK Push "Simulate" page copy the test Shortcode (174379) and Passkey.
 *   3. Safaricom must reach your callback over public HTTPS. Locally, run a tunnel such as
 *        ngrok http 3000
 *      and set MPESA_CALLBACK_BASE_URL to the https URL it prints.
 *      The server registers  <BASE_URL>/api/mpesa/callback/<MPESA_CALLBACK_SECRET>  per payment.
 *   4. Click "Donate Now", use the sandbox test phone 254708374149 and any amount.
 *      The sandbox does not send a real prompt to a phone; the simulator/callback completes it.
 *   5. Safety net: even if the callback is lost, the server confirms every payment directly
 *      with Safaricom (STK Query) before it is ever counted. Nothing unverified is counted.
 *
 * ======================================================================
 * PRODUCTION DEPLOYMENT CHECKLIST
 * ======================================================================
 *   - Host on a Node-capable server/VPS/PaaS with a persistent disk (SQLite file + uploads/).
 *   - NODE_ENV=production, TRUST_PROXY=1 behind a proxy, serve over HTTPS only (Nginx/Caddy).
 *   - Apply for Daraja "Go Live", then set MPESA_ENV=production with your real Paybill/Till,
 *     production Consumer Key/Secret, and Passkey. Use a real MIN_DONATION.
 *   - Set MPESA_CALLBACK_BASE_URL to your public https domain.
 *   - Restrict the Google Maps key to your domain.
 *   - Back up data/fpck.db and uploads/ regularly.
 *   - Run with a process manager (pm2 / systemd) so it restarts automatically.
 *   - Replace all demonstration data (marked "Demo data" on the site) with real church details.
 *
 * Useful SQL (sqlite3 data/fpck.db):
 *   UPDATE settings SET value='3000000' WHERE key='fundraising_initial';  -- amount already raised before the site
 *   UPDATE settings SET value='7000000' WHERE key='fundraising_target';
 *   DELETE FROM churches WHERE is_demo=1;                                 -- remove all demo churches
 */

'use strict';

require('dotenv').config();

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Database = require('better-sqlite3');

/* ----------------------------------------------------------------------------
 * Configuration
 * -------------------------------------------------------------------------- */
const env = process.env;
const PORT = Number(env.PORT) || 3000;
const IS_PROD = env.NODE_ENV === 'production';
const JWT_SECRET = env.JWT_SECRET || '';

if (JWT_SECRET.length < 32) {
  console.error('FATAL: JWT_SECRET is missing or shorter than 32 characters. See setup notes at the top of server.js.');
  process.exit(1);
}

const MPESA = {
  env: env.MPESA_ENV === 'production' ? 'production' : 'sandbox',
  consumerKey: env.MPESA_CONSUMER_KEY || '',
  consumerSecret: env.MPESA_CONSUMER_SECRET || '',
  shortCode: env.MPESA_SHORTCODE || '',
  passkey: env.MPESA_PASSKEY || '',
  txType: env.MPESA_TRANSACTION_TYPE === 'CustomerBuyGoodsOnline' ? 'CustomerBuyGoodsOnline' : 'CustomerPayBillOnline',
  callbackBase: (env.MPESA_CALLBACK_BASE_URL || '').replace(/\/+$/, ''),
  callbackSecret: env.MPESA_CALLBACK_SECRET || '',
};
MPESA.baseUrl = MPESA.env === 'production' ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke';
const mpesaReady = () =>
  Boolean(MPESA.consumerKey && MPESA.consumerSecret && MPESA.shortCode && MPESA.passkey &&
    MPESA.callbackBase.startsWith('https://') && MPESA.callbackSecret.length >= 20);

const MIN_DONATION = Math.max(1, Number(env.MIN_DONATION) || 10);
const MAX_DONATION = 150000; // M-Pesa single-transaction ceiling

const DATA_DIR = path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const GALLERY_CATEGORIES = ['Sunday Service', 'Worship', 'Baptism', 'Conference', 'Youth', 'Outreach', 'Other'];

/* ----------------------------------------------------------------------------
 * Database
 * -------------------------------------------------------------------------- */
const db = new Database(path.join(DATA_DIR, 'fpck.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS churches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  county TEXT NOT NULL,
  town TEXT NOT NULL,
  address TEXT NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  phone TEXT,
  email TEXT,
  service_times TEXT NOT NULL DEFAULT '[]',
  pastor_name TEXT,
  pastor_bio TEXT,
  clergy TEXT NOT NULL DEFAULT '[]',
  activities TEXT NOT NULL DEFAULT '[]',
  photos TEXT NOT NULL DEFAULT '[]',
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS gallery (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  filename TEXT,
  caption TEXT NOT NULL,
  category TEXT NOT NULL,
  is_demo INTEGER NOT NULL DEFAULT 0,
  uploaded_by TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS contributions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reference TEXT UNIQUE NOT NULL,
  checkout_request_id TEXT UNIQUE,
  merchant_request_id TEXT,
  phone TEXT NOT NULL,
  amount INTEGER NOT NULL,
  status TEXT NOT NULL,              -- PENDING | CALLBACK_RECEIVED | SUCCESS | FAILED | CANCELLED | EXPIRED
  mpesa_receipt TEXT UNIQUE,
  result_code INTEGER,
  result_desc TEXT,
  verified_via TEXT,                 -- callback+query | query
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_contrib_status ON contributions(status);
CREATE TABLE IF NOT EXISTS contact_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

const nowIso = () => new Date().toISOString();
const getSetting = (k, d) => {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(k);
  return r ? r.value : d;
};
db.prepare("INSERT OR IGNORE INTO settings(key, value) VALUES ('fundraising_target', '7000000')").run();
db.prepare("INSERT OR IGNORE INTO settings(key, value) VALUES ('fundraising_initial', '3000000')").run();

/* ----------------------------------------------------------------------------
 * Demonstration data (clearly flagged is_demo = 1; replace with real details)
 * -------------------------------------------------------------------------- */
function seedDemoData() {
  if (db.prepare('SELECT COUNT(*) AS c FROM churches').get().c === 0) {
    const std = (extra = []) => [
      { day: 'Sunday', time: '8:00 AM', label: 'First Service' },
      { day: 'Sunday', time: '10:30 AM', label: 'Main Worship Service' },
      { day: 'Wednesday', time: '6:00 PM', label: 'Prayer & Bible Study' },
      ...extra,
    ];
    const acts = (a) => a;
    const demo = [
      {
        name: 'FPCK Sielo Headquarters Church', county: 'Headquarters', town: 'Sielo',
        address: 'Sielo, Kenya — demo address and placeholder map pin, replace with the exact location',
        lat: 0.0236, lng: 37.9062, phone: '+254 700 000 001', email: 'headquarters@example.org',
        service_times: std([{ day: 'Friday', time: '6:00 PM', label: 'Night Vigil (first Friday)' }]),
        pastor_name: 'Rev. Samuel Mwangi (demo name)',
        pastor_bio: 'Demonstration profile. Replace with the resident pastor’s real biography, years of service and ministry focus.',
        clergy: [
          { name: 'Bishop David Nziyakom', role: 'Presiding Bishop', bio: 'Leads the Free Pentecostal Churches of Kenya. Biography to be added.' },
          { name: 'Pastor Esther Njeri (demo name)', role: 'Associate Pastor', bio: 'Demonstration profile — women’s and family ministry.' },
        ],
        activities: acts(['Building fund drive for the new sanctuary', 'Annual leaders’ conference planning', 'Weekly children’s Sunday school']),
      },
      {
        name: 'FPCK Umoja Church', county: 'Nairobi', town: 'Umoja',
        address: 'Umoja Estate, Nairobi (demo address)', lat: -1.2833, lng: 36.8944,
        phone: '+254 700 000 002', email: 'umoja@example.org',
        service_times: std([{ day: 'Saturday', time: '4:00 PM', label: 'Youth Fellowship' }]),
        pastor_name: 'Pastor Joyce Kamau (demo name)',
        pastor_bio: 'Demonstration profile. Passionate about urban youth discipleship and community outreach.',
        clergy: [{ name: 'Elder Moses Otieno (demo name)', role: 'Church Elder', bio: 'Demonstration profile.' }],
        activities: acts(['Youth leadership retreat', 'Food-support outreach, first Saturday monthly']),
      },
      {
        name: 'FPCK Thika Town Church', county: 'Kiambu', town: 'Thika',
        address: 'Kenyatta Highway, Thika (demo address)', lat: -1.0396, lng: 37.09,
        phone: '+254 700 000 003', email: 'thika@example.org',
        service_times: std(),
        pastor_name: 'Rev. Peter Gathogo (demo name)',
        pastor_bio: 'Demonstration profile. Serves a growing congregation with a heart for teaching.',
        clergy: [{ name: 'Deaconess Ruth Wambui (demo name)', role: 'Head of Women’s Ministry', bio: 'Demonstration profile.' }],
        activities: acts(['Marriage enrichment seminar', 'Choir recruitment and training']),
      },
      {
        name: 'FPCK Nakuru Central Church', county: 'Nakuru', town: 'Nakuru',
        address: 'Off Kenyatta Avenue, Nakuru (demo address)', lat: -0.3031, lng: 36.08,
        phone: '+254 700 000 004', email: 'nakuru@example.org',
        service_times: std([{ day: 'Friday', time: '5:30 PM', label: 'Intercession Hour' }]),
        pastor_name: 'Pastor John Kiprop (demo name)',
        pastor_bio: 'Demonstration profile. Known for expository preaching and prayer ministry.',
        clergy: [{ name: 'Evangelist Mary Chebet (demo name)', role: 'Evangelism Lead', bio: 'Demonstration profile.' }],
        activities: acts(['Door-to-door evangelism week', 'Prayer and fasting, last Friday monthly']),
      },
      {
        name: 'FPCK Milimani Church', county: 'Kisumu', town: 'Kisumu',
        address: 'Milimani, Kisumu (demo address)', lat: -0.0917, lng: 34.768,
        phone: '+254 700 000 005', email: 'kisumu@example.org',
        service_times: std(),
        pastor_name: 'Rev. Peter Otieno (demo name)',
        pastor_bio: 'Demonstration profile. Leads a lakeside congregation and a community school ministry.',
        clergy: [{ name: 'Pastor Beatrice Akinyi (demo name)', role: 'Children’s Pastor', bio: 'Demonstration profile.' }],
        activities: acts(['Baptism service planned this quarter', 'School fees support programme']),
      },
      {
        name: 'FPCK Nyali Church', county: 'Mombasa', town: 'Nyali',
        address: 'Nyali, Mombasa (demo address)', lat: -4.0286, lng: 39.7094,
        phone: '+254 700 000 006', email: 'nyali@example.org',
        service_times: std([{ day: 'Sunday', time: '4:00 PM', label: 'Swahili Service' }]),
        pastor_name: 'Pastor Hamisi Juma (demo name)',
        pastor_bio: 'Demonstration profile. Bilingual ministry across the coast.',
        clergy: [{ name: 'Elder Fatuma Salim (demo name)', role: 'Church Elder', bio: 'Demonstration profile.' }],
        activities: acts(['Coastal praise night', 'Community clean-up and outreach']),
      },
      {
        name: 'FPCK Machakos Town Church', county: 'Machakos', town: 'Machakos',
        address: 'Machakos Town (demo address)', lat: -1.5177, lng: 37.2634,
        phone: '+254 700 000 007', email: 'machakos@example.org',
        service_times: std(),
        pastor_name: 'Pastor Daniel Musyoka (demo name)',
        pastor_bio: 'Demonstration profile. Focused on discipleship and church planting.',
        clergy: [{ name: 'Elder Agnes Mutua (demo name)', role: 'Church Elder', bio: 'Demonstration profile.' }],
        activities: acts(['New believers’ class', 'Planting a new congregation in a nearby town']),
      },
      {
        name: 'FPCK Eldoret Church', county: 'Uasin Gishu', town: 'Eldoret',
        address: 'Eldoret Town (demo address)', lat: 0.5143, lng: 35.2698,
        phone: '+254 700 000 008', email: 'eldoret@example.org',
        service_times: std([{ day: 'Thursday', time: '6:00 PM', label: 'Worship Practice' }]),
        pastor_name: 'Rev. Hellen Jepkoech (demo name)',
        pastor_bio: 'Demonstration profile. Worship-centred ministry with an active choir.',
        clergy: [{ name: 'Pastor Kevin Rotich (demo name)', role: 'Worship Pastor', bio: 'Demonstration profile.' }],
        activities: acts(['Annual choir competition', 'Mid-year conference preparation']),
      },
    ];
    const ins = db.prepare(`INSERT INTO churches
      (slug,name,county,town,address,lat,lng,phone,email,service_times,pastor_name,pastor_bio,clergy,activities,photos,is_demo,created_at)
      VALUES (@slug,@name,@county,@town,@address,@lat,@lng,@phone,@email,@service_times,@pastor_name,@pastor_bio,@clergy,@activities,'[]',1,@created_at)`);
    db.transaction(() => {
      for (const c of demo) {
        ins.run({
          ...c, slug: slugify(`${c.name}`), created_at: nowIso(),
          service_times: JSON.stringify(c.service_times), clergy: JSON.stringify(c.clergy), activities: JSON.stringify(c.activities),
        });
      }
    })();
  }
  if (db.prepare('SELECT COUNT(*) AS c FROM gallery').get().c === 0) {
    const items = [
      ['Sunday morning worship — demonstration caption', 'Sunday Service'],
      ['Praise team leading the congregation — demonstration caption', 'Worship'],
      ['Baptism at the river — demonstration caption', 'Baptism'],
      ['Annual conference opening session — demonstration caption', 'Conference'],
      ['Youth fellowship and games day — demonstration caption', 'Youth'],
      ['Community outreach and food support — demonstration caption', 'Outreach'],
      ['Choir ministering on Easter Sunday — demonstration caption', 'Worship'],
      ['Leaders’ prayer retreat — demonstration caption', 'Conference'],
    ];
    const ins = db.prepare('INSERT INTO gallery(filename,caption,category,is_demo,uploaded_by,created_at) VALUES (NULL,?,?,1,?,?)');
    db.transaction(() => items.forEach(([c, k]) => ins.run(c, k, 'demo', nowIso())))();
  }
}

function slugify(s) {
  return String(s).toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_-]+/g, '-').slice(0, 80) || 'church';
}

function bootstrapAdmin() {
  if (db.prepare('SELECT COUNT(*) AS c FROM admins').get().c > 0) return;
  const u = (env.ADMIN_USERNAME || '').trim();
  const p = env.ADMIN_PASSWORD || '';
  if (!u || p.length < 12) {
    console.warn('No administrator exists. Set ADMIN_USERNAME and an ADMIN_PASSWORD of 12+ characters in .env, then restart.');
    return;
  }
  db.prepare('INSERT INTO admins(username,password_hash,created_at) VALUES (?,?,?)').run(u, bcrypt.hashSync(p, 12), nowIso());
  console.log(`Administrator "${u}" created. Remove ADMIN_PASSWORD from .env now.`);
}

seedDemoData();
bootstrapAdmin();

/* ----------------------------------------------------------------------------
 * Express app + security
 * -------------------------------------------------------------------------- */
const app = express();
if (env.TRUST_PROXY) app.set('trust proxy', Number(env.TRUST_PROXY) || 1);
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.locals.nonce = crypto.randomBytes(16).toString('base64');
  next();
});
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", (req, res) => `'nonce-${res.locals.nonce}'`],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:', 'blob:'],
        frameSrc: ['https://www.google.com', 'https://maps.google.com'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'self'"],
        ...(IS_PROD ? { upgradeInsecureRequests: [] } : {}),
      },
    },
    crossOriginEmbedderPolicy: false,
  })
);
app.use(express.json({ limit: '20kb' }));

const limiter = (windowMin, max, message) =>
  rateLimit({ windowMs: windowMin * 60 * 1000, limit: max, standardHeaders: true, legacyHeaders: false, message: { error: message } });
app.use('/api/', limiter(15, 400, 'Too many requests. Please slow down.'));
const donateLimiter = limiter(10, 6, 'Too many payment attempts. Please wait a few minutes and try again.');
const loginLimiter = limiter(15, 10, 'Too many login attempts. Try again later.');
const contactLimiter = limiter(30, 5, 'Too many messages. Please try again later.');

/* ----------------------------------------------------------------------------
 * Static files (only the three project files + uploads are ever served)
 * -------------------------------------------------------------------------- */
let indexCache = null;
function sendIndex(req, res) {
  const read = () => fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  const html = IS_PROD ? (indexCache = indexCache || read()) : read();
  res.set('Cache-Control', 'no-cache');
  res.type('html').send(html.replace(/__CSP_NONCE__/g, res.locals.nonce));
}
app.get('/', sendIndex);
app.get('/index.html', sendIndex);
app.get('/style.css', (req, res) => {
  res.set('Cache-Control', IS_PROD ? 'public, max-age=3600' : 'no-cache');
  res.sendFile(path.join(__dirname, 'style.css'));
});
app.use('/uploads', express.static(UPLOAD_DIR, { index: false, dotfiles: 'deny', maxAge: '7d', immutable: true }));

/* ----------------------------------------------------------------------------
 * Helpers
 * -------------------------------------------------------------------------- */
const clean = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max);
const safeEqual = (a, b) => {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
};
const isEmail = (s) => /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/.test(s);

function normalisePhone(raw) {
  let p = String(raw || '').replace(/[\s\-()]/g, '');
  if (p.startsWith('+')) p = p.slice(1);
  if (/^0[17]\d{8}$/.test(p)) p = '254' + p.slice(1);
  else if (/^[17]\d{8}$/.test(p)) p = '254' + p;
  return /^254[17]\d{8}$/.test(p) ? p : null;
}
const maskPhone = (p) => (p ? `${p.slice(0, 5)}***${p.slice(-3)}` : '');

const parseJson = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
const churchOut = (r) => ({
  id: r.id, slug: r.slug, name: r.name, county: r.county, town: r.town, address: r.address,
  lat: r.lat, lng: r.lng, phone: r.phone, email: r.email,
  serviceTimes: parseJson(r.service_times, []), pastorName: r.pastor_name, pastorBio: r.pastor_bio,
  clergy: parseJson(r.clergy, []), activities: parseJson(r.activities, []), photos: parseJson(r.photos, []),
  isDemo: !!r.is_demo,
});

function detectImage(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: 'jpg' };
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { ext: 'png' };
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return { ext: 'webp' };
  if (buf.slice(0, 3).toString('ascii') === 'GIF') return { ext: 'gif' };
  return null;
}
function saveImage(buffer) {
  const type = detectImage(buffer);
  if (!type) return null;
  const filename = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}.${type.ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, filename), buffer, { flag: 'wx' });
  return filename;
}
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 6 * 1024 * 1024, files: 1, fields: 5 } });

/* ----------------------------------------------------------------------------
 * Admin authentication
 * -------------------------------------------------------------------------- */
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(8).toString('hex'), 12);

app.post('/api/admin/login', loginLimiter, (req, res) => {
  const username = clean(req.body.username, 60);
  const password = String(req.body.password || '').slice(0, 200);
  const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(username);
  const ok = bcrypt.compareSync(password, admin ? admin.password_hash : DUMMY_HASH);
  if (!admin || !ok) return res.status(401).json({ error: 'Incorrect username or password.' });
  const token = jwt.sign({ sub: admin.id, u: admin.username }, JWT_SECRET, { expiresIn: '8h', algorithm: 'HS256' });
  res.json({ token, username: admin.username });
});

function requireAdmin(req, res, next) {
  const h = req.get('authorization') || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  try {
    const p = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    const admin = db.prepare('SELECT id, username FROM admins WHERE id = ?').get(p.sub);
    if (!admin) throw new Error('unknown admin');
    req.admin = admin;
    next();
  } catch {
    res.status(401).json({ error: 'Please sign in as an administrator.' });
  }
}
app.get('/api/admin/me', requireAdmin, (req, res) => res.json({ username: req.admin.username }));

/* ----------------------------------------------------------------------------
 * Public API: config, churches, gallery, contact
 * -------------------------------------------------------------------------- */
app.get('/api/config', (req, res) => {
  res.json({
    mapsEmbedKey: env.GOOGLE_MAPS_EMBED_KEY || '',
    paymentsEnabled: mpesaReady(),
    minDonation: MIN_DONATION,
    maxDonation: MAX_DONATION,
    galleryCategories: GALLERY_CATEGORIES,
  });
});

app.get('/api/churches', (req, res) => {
  const rows = db.prepare('SELECT * FROM churches ORDER BY county, town, name').all();
  res.json(rows.map(churchOut));
});

app.get('/api/gallery', (req, res) => {
  const rows = db.prepare('SELECT * FROM gallery ORDER BY id DESC LIMIT 200').all();
  res.json(rows.map((r) => ({
    id: r.id, url: r.filename ? `/uploads/${r.filename}` : null, caption: r.caption, category: r.category,
    isDemo: !!r.is_demo, createdAt: r.created_at,
  })));
});

app.post('/api/contact', contactLimiter, (req, res) => {
  const name = clean(req.body.name, 100);
  const email = clean(req.body.email, 200);
  const phone = clean(req.body.phone, 30);
  const message = clean(req.body.message, 2000);
  if (!name || message.length < 5) return res.status(400).json({ error: 'Please enter your name and a message.' });
  if (!email && !phone) return res.status(400).json({ error: 'Please give an email address or phone number so we can reply.' });
  if (email && !isEmail(email)) return res.status(400).json({ error: 'That email address does not look right.' });
  db.prepare('INSERT INTO contact_messages(name,email,phone,message,created_at) VALUES (?,?,?,?,?)')
    .run(name, email || null, phone || null, message, nowIso());
  res.status(201).json({ ok: true });
});

/* ----------------------------------------------------------------------------
 * Admin API: gallery, churches, reports
 * -------------------------------------------------------------------------- */
app.post('/api/admin/gallery', requireAdmin, upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Choose an image to upload.' });
  const caption = clean(req.body.caption, 200);
  const category = GALLERY_CATEGORIES.includes(req.body.category) ? req.body.category : 'Other';
  if (!caption) return res.status(400).json({ error: 'Add a short caption.' });
  const filename = saveImage(req.file.buffer);
  if (!filename) return res.status(400).json({ error: 'Only JPG, PNG, WebP or GIF images are allowed.' });
  const info = db.prepare('INSERT INTO gallery(filename,caption,category,is_demo,uploaded_by,created_at) VALUES (?,?,?,0,?,?)')
    .run(filename, caption, category, req.admin.username, nowIso());
  res.status(201).json({ id: info.lastInsertRowid, url: `/uploads/${filename}`, caption, category });
});

app.delete('/api/admin/gallery/:id', requireAdmin, (req, res) => {
  const row = db.prepare('SELECT * FROM gallery WHERE id = ?').get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Photo not found.' });
  db.prepare('DELETE FROM gallery WHERE id = ?').run(row.id);
  if (row.filename) fs.unlink(path.join(UPLOAD_DIR, path.basename(row.filename)), () => {});
  res.json({ ok: true });
});

function cleanChurch(b) {
  const out = {
    name: clean(b.name, 120), county: clean(b.county, 60), town: clean(b.town, 60), address: clean(b.address, 250),
    lat: Number(b.lat), lng: Number(b.lng), phone: clean(b.phone, 30), email: clean(b.email, 200),
    pastor_name: clean(b.pastorName, 120), pastor_bio: clean(b.pastorBio, 1200),
  };
  if (!out.name || !out.county || !out.town || !out.address) return { error: 'Name, county, town and address are required.' };
  if (!(out.lat >= -5 && out.lat <= 5.5 && out.lng >= 33 && out.lng <= 42.5)) return { error: 'Latitude/longitude must be inside Kenya.' };
  if (out.email && !isEmail(out.email)) return { error: 'The church email address does not look right.' };
  const arr = (v) => (Array.isArray(v) ? v : []);
  out.service_times = JSON.stringify(arr(b.serviceTimes).slice(0, 10).map((s) => ({ day: clean(s.day, 20), time: clean(s.time, 20), label: clean(s.label, 80) })).filter((s) => s.day && s.time));
  out.clergy = JSON.stringify(arr(b.clergy).slice(0, 12).map((c) => ({ name: clean(c.name, 100), role: clean(c.role, 80), bio: clean(c.bio, 600) })).filter((c) => c.name));
  out.activities = JSON.stringify(arr(b.activities).slice(0, 12).map((a) => clean(a, 160)).filter(Boolean));
  return { value: out };
}

app.post('/api/admin/churches', requireAdmin, (req, res) => {
  const { value, error } = cleanChurch(req.body);
  if (error) return res.status(400).json({ error });
  let slug = slugify(`${value.name}`);
  while (db.prepare('SELECT 1 FROM churches WHERE slug = ?').get(slug)) slug += '-' + crypto.randomBytes(2).toString('hex');
  db.prepare(`INSERT INTO churches (slug,name,county,town,address,lat,lng,phone,email,service_times,pastor_name,pastor_bio,clergy,activities,photos,is_demo,created_at)
    VALUES (@slug,@name,@county,@town,@address,@lat,@lng,@phone,@email,@service_times,@pastor_name,@pastor_bio,@clergy,@activities,'[]',0,@created_at)`)
    .run({ ...value, slug, created_at: nowIso() });
  res.status(201).json(churchOut(db.prepare('SELECT * FROM churches WHERE slug = ?').get(slug)));
});

app.put('/api/admin/churches/:id', requireAdmin, (req, res) => {
  const existing = db.prepare('SELECT id FROM churches WHERE id = ?').get(Number(req.params.id));
  if (!existing) return res.status(404).json({ error: 'Church not found.' });
  const { value, error } = cleanChurch(req.body);
  if (error) return res.status(400).json({ error });
  db.prepare(`UPDATE churches SET name=@name,county=@county,town=@town,address=@address,lat=@lat,lng=@lng,phone=@phone,email=@email,
    service_times=@service_times,pastor_name=@pastor_name,pastor_bio=@pastor_bio,clergy=@clergy,activities=@activities,is_demo=0 WHERE id=@id`)
    .run({ ...value, id: existing.id });
  res.json(churchOut(db.prepare('SELECT * FROM churches WHERE id = ?').get(existing.id)));
});

app.delete('/api/admin/churches/:id', requireAdmin, (req, res) => {
  const r = db.prepare('DELETE FROM churches WHERE id = ?').run(Number(req.params.id));
  if (!r.changes) return res.status(404).json({ error: 'Church not found.' });
  res.json({ ok: true });
});

app.post('/api/admin/churches/:id/photos', requireAdmin, upload.single('image'), (req, res) => {
  const row = db.prepare('SELECT * FROM churches WHERE id = ?').get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Church not found.' });
  if (!req.file) return res.status(400).json({ error: 'Choose an image to upload.' });
  const photos = parseJson(row.photos, []);
  if (photos.length >= 12) return res.status(400).json({ error: 'A church can have up to 12 photos.' });
  const filename = saveImage(req.file.buffer);
  if (!filename) return res.status(400).json({ error: 'Only JPG, PNG, WebP or GIF images are allowed.' });
  photos.push(`/uploads/${filename}`);
  db.prepare('UPDATE churches SET photos = ? WHERE id = ?').run(JSON.stringify(photos), row.id);
  res.status(201).json({ photos });
});

app.get('/api/admin/contributions', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT * FROM contributions ORDER BY id DESC LIMIT 200').all();
  res.json(rows.map((r) => ({
    reference: r.reference, phone: r.phone, amount: r.amount, status: r.status, receipt: r.mpesa_receipt,
    resultDesc: r.result_desc, verifiedVia: r.verified_via, createdAt: r.created_at, completedAt: r.completed_at,
  })));
});

app.get('/api/admin/messages', requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT * FROM contact_messages ORDER BY id DESC LIMIT 200').all());
});

/* ----------------------------------------------------------------------------
 * Fundraising
 * -------------------------------------------------------------------------- */
function fundraising() {
  const target = Number(getSetting('fundraising_target', '7000000'));
  const initial = Number(getSetting('fundraising_initial', '3000000'));
  const v = db.prepare("SELECT COALESCE(SUM(amount),0) AS total, COUNT(*) AS n FROM contributions WHERE status = 'SUCCESS'").get();
  const raised = initial + v.total;                       // only verified payments are ever added
  const remaining = Math.max(0, target - raised);
  const percent = target > 0 ? Math.min(100, Math.round((raised / target) * 1000) / 10) : 0;
  return { target, initial, verifiedTotal: v.total, verifiedCount: v.n, raised, remaining, percent };
}
app.get('/api/fundraising', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(fundraising());
});

/* ----------------------------------------------------------------------------
 * M-Pesa Daraja: STK Push
 * -------------------------------------------------------------------------- */
let tokenCache = { value: null, expires: 0 };

async function mpesaToken() {
  if (tokenCache.value && Date.now() < tokenCache.expires) return tokenCache.value;
  const basic = Buffer.from(`${MPESA.consumerKey}:${MPESA.consumerSecret}`).toString('base64');
  const r = await fetch(`${MPESA.baseUrl}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${basic}` },
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`Daraja auth failed (HTTP ${r.status})`);
  const j = await r.json();
  if (!j.access_token) throw new Error('Daraja auth returned no token');
  tokenCache = { value: j.access_token, expires: Date.now() + (Number(j.expires_in) - 60) * 1000 };
  return tokenCache.value;
}

function darajaStamp() {
  // Daraja expects YYYYMMDDHHmmss (Nairobi time, UTC+3)
  const d = new Date(Date.now() + 3 * 3600 * 1000);
  const timestamp = d.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const password = Buffer.from(`${MPESA.shortCode}${MPESA.passkey}${timestamp}`).toString('base64');
  return { timestamp, password };
}

async function darajaPost(pathName, body) {
  const token = await mpesaToken();
  const r = await fetch(`${MPESA.baseUrl}${pathName}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  let j = {};
  try { j = await r.json(); } catch { /* non-JSON error body */ }
  return { status: r.status, body: j };
}

async function stkPush({ phone, amount, reference }) {
  const { timestamp, password } = darajaStamp();
  return darajaPost('/mpesa/stkpush/v1/processrequest', {
    BusinessShortCode: MPESA.shortCode,
    Password: password,
    Timestamp: timestamp,
    TransactionType: MPESA.txType,
    Amount: amount,
    PartyA: phone,
    PartyB: MPESA.shortCode,
    PhoneNumber: phone,
    CallBackURL: `${MPESA.callbackBase}/api/mpesa/callback/${MPESA.callbackSecret}`,
    AccountReference: reference,        // max 12 characters
    TransactionDesc: 'FPCK Giving',
  });
}

async function stkQuery(checkoutRequestId) {
  const { timestamp, password } = darajaStamp();
  return darajaPost('/mpesa/stkpushquery/v1/query', {
    BusinessShortCode: MPESA.shortCode, Password: password, Timestamp: timestamp, CheckoutRequestID: checkoutRequestId,
  });
}

const OPEN_STATES = "('PENDING','CALLBACK_RECEIVED')";

function markFailed(id, code, desc) {
  const status = Number(code) === 1032 ? 'CANCELLED' : 'FAILED';
  db.prepare(`UPDATE contributions SET status=?, result_code=?, result_desc=?, completed_at=? WHERE id=? AND status IN ${OPEN_STATES}`)
    .run(status, Number(code), clean(desc, 200), nowIso(), id);
}

function markSuccess(row, via, desc) {
  try {
    db.prepare(`UPDATE contributions SET status='SUCCESS', result_code=0, result_desc=?, verified_via=?, completed_at=?
      WHERE id=? AND status IN ${OPEN_STATES}`).run(clean(desc, 200), via, nowIso(), row.id);
  } catch (e) {
    console.error('Could not finalise contribution', row.reference, e.message);
  }
}

/** Ask Safaricom directly for the outcome. Only a confirmed ResultCode 0 can create a SUCCESS. */
async function confirmWithSafaricom(row) {
  if (!row.checkout_request_id) return;
  const { body } = await stkQuery(row.checkout_request_id);
  if (body.errorCode || body.ResponseCode !== '0') return;       // still processing or temporary error: try again later
  const code = Number(body.ResultCode);
  if (Number.isNaN(code)) return;
  if (code === 0) markSuccess(row, row.status === 'CALLBACK_RECEIVED' ? 'callback+query' : 'query', body.ResultDesc);
  else markFailed(row.id, code, body.ResultDesc);
}

function handleCallback(payload) {
  const cb = payload && payload.Body && payload.Body.stkCallback;
  if (!cb || !cb.CheckoutRequestID) return;
  const row = db.prepare('SELECT * FROM contributions WHERE checkout_request_id = ?').get(String(cb.CheckoutRequestID));
  if (!row || !['PENDING', 'CALLBACK_RECEIVED'].includes(row.status)) return;   // unknown or already settled: ignore

  const code = Number(cb.ResultCode);
  if (code !== 0) return markFailed(row.id, code, cb.ResultDesc);

  const items = (cb.CallbackMetadata && cb.CallbackMetadata.Item) || [];
  const meta = Object.fromEntries(items.map((i) => [i.Name, i.Value]));
  const receipt = String(meta.MpesaReceiptNumber || '');
  if (Number(meta.Amount) !== row.amount || !/^[A-Z0-9]{8,12}$/.test(receipt)) {
    console.warn('Callback mismatch for', row.reference, '- not counted; will be checked directly with Safaricom.');
    db.prepare('UPDATE contributions SET result_desc=? WHERE id=?').run('Callback did not match request', row.id);
    return;
  }
  try {
    db.prepare("UPDATE contributions SET status='CALLBACK_RECEIVED', mpesa_receipt=?, result_code=0, result_desc=? WHERE id=? AND status='PENDING'")
      .run(receipt, clean(cb.ResultDesc, 200), row.id);
  } catch (e) {
    console.warn('Duplicate receipt rejected for', row.reference);
    return;
  }
  // Defence in depth: the callback alone is never trusted. Confirm with Safaricom, then count it.
  const fresh = db.prepare('SELECT * FROM contributions WHERE id = ?').get(row.id);
  confirmWithSafaricom(fresh).catch((e) => console.error('Verification pending for', row.reference, '-', e.message));
}

app.post('/api/mpesa/callback/:secret', (req, res) => {
  if (!safeEqual(req.params.secret, MPESA.callbackSecret || crypto.randomBytes(16).toString('hex'))) return res.status(404).end();
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });   // acknowledge quickly; Safaricom retries otherwise
  try { handleCallback(req.body); } catch (e) { console.error('Callback handling error:', e.message); }
});

app.post('/api/donations', donateLimiter, async (req, res) => {
  if (!mpesaReady()) return res.status(503).json({ error: 'Online giving is not switched on yet. Please try again soon.' });
  const phone = normalisePhone(req.body.phone);
  const amount = Number(req.body.amount);
  if (!phone) return res.status(400).json({ error: 'Enter a valid Safaricom number, for example 0712 345 678.' });
  if (!Number.isInteger(amount) || amount < MIN_DONATION || amount > MAX_DONATION) {
    return res.status(400).json({ error: `Enter a whole amount between KSh ${MIN_DONATION.toLocaleString('en-KE')} and KSh ${MAX_DONATION.toLocaleString('en-KE')}.` });
  }
  const reference = `FPCK${crypto.randomBytes(4).toString('hex').toUpperCase()}`;   // 12 characters
  const info = db.prepare("INSERT INTO contributions(reference,phone,amount,status,created_at) VALUES (?,?,?,'PENDING',?)")
    .run(reference, phone, amount, nowIso());
  try {
    const { body } = await stkPush({ phone, amount, reference });
    if (body.ResponseCode !== '0' || !body.CheckoutRequestID) {
      markFailed(info.lastInsertRowid, 1, body.errorMessage || body.ResponseDescription || 'STK request rejected');
      return res.status(502).json({ error: 'M-Pesa could not start the payment. Please check the number and try again.' });
    }
    db.prepare('UPDATE contributions SET checkout_request_id=?, merchant_request_id=? WHERE id=?')
      .run(body.CheckoutRequestID, body.MerchantRequestID || null, info.lastInsertRowid);
    res.status(202).json({ reference, message: 'Check your phone and enter your M-Pesa PIN to complete the gift.' });
  } catch (e) {
    console.error('STK push error:', e.message);
    markFailed(info.lastInsertRowid, 1, 'Could not reach M-Pesa');
    res.status(502).json({ error: 'We could not reach M-Pesa. No money was taken. Please try again shortly.' });
  }
});

app.get('/api/donations/:reference/status', (req, res) => {
  const r = db.prepare('SELECT reference, status, amount, mpesa_receipt, result_desc FROM contributions WHERE reference = ?')
    .get(clean(req.params.reference, 20));
  if (!r) return res.status(404).json({ error: 'Payment not found.' });
  const state = r.status === 'SUCCESS' ? 'success' : ['FAILED', 'CANCELLED', 'EXPIRED'].includes(r.status) ? 'failed' : 'pending';
  res.set('Cache-Control', 'no-store');
  res.json({ reference: r.reference, state, amount: r.amount, receipt: state === 'success' ? r.mpesa_receipt : null,
    message: state === 'failed' ? (r.status === 'CANCELLED' ? 'The prompt was cancelled on your phone.' : r.result_desc || 'The payment was not completed.') : null });
});

/** Background reconciliation: confirms open payments directly with Safaricom, expires stale ones. */
async function reconcileOpenPayments() {
  if (!mpesaReady()) return;
  const cutoff = new Date(Date.now() - 45 * 1000).toISOString();
  const rows = db.prepare(`SELECT * FROM contributions WHERE status IN ${OPEN_STATES} AND checkout_request_id IS NOT NULL AND created_at < ? ORDER BY id LIMIT 20`).all(cutoff);
  for (const row of rows) {
    try { await confirmWithSafaricom(row); } catch (e) { console.error('Reconcile error for', row.reference, e.message); }
  }
  const stale = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  db.prepare(`UPDATE contributions SET status='EXPIRED', result_desc='No confirmation received', completed_at=? WHERE status IN ${OPEN_STATES} AND created_at < ?`)
    .run(nowIso(), stale);
}
setInterval(() => reconcileOpenPayments().catch(() => {}), 60 * 1000).unref();

/* ----------------------------------------------------------------------------
 * Errors
 * -------------------------------------------------------------------------- */
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
app.use((req, res) => res.status(404).type('text').send('Not found'));
app.use((err, req, res, next) => {     // eslint-disable-line no-unused-vars
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Image is too large (6 MB maximum).' : 'Upload failed.' });
  }
  if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') return res.status(400).json({ error: 'Invalid request.' });
  console.error('Unhandled error:', err.message);
  res.status(500).json({ error: 'Something went wrong on our side.' });
});

app.listen(PORT, () => {
  console.log(`FPCK website running on http://localhost:${PORT}  (${IS_PROD ? 'production' : 'development'})`);
  console.log(mpesaReady() ? `M-Pesa: ${MPESA.env} mode ready.` : 'M-Pesa: not configured — Donate Now will show "not switched on" until the MPESA_* settings are added.');
});
