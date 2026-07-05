const express   = require('express');
const path      = require('path');
const { Pool }  = require('pg');
const fs        = require('fs');
const https     = require('https');
const http      = require('http');

// ── PUPPETEER (headless browser for JS-rendered pages) ──
let _puppeteer = null;
async function getPuppeteer() {
  if (_puppeteer) return _puppeteer;
  try {
    const puppeteer = require('puppeteer-extra');
    const StealthPlugin = require('puppeteer-extra-plugin-stealth');
    puppeteer.use(StealthPlugin());
    _puppeteer = puppeteer;
    return puppeteer;
  } catch(e) {
    console.warn('Puppeteer unavailable:', e.message);
    return null;
  }
}

// ── AI PROVIDERS ──────────────────────────────────────────
let _openai = null, _openrouter = null, _anthropic = null;

try {
  if (process.env.OPENROUTER_API_KEY) {
    const { OpenAI } = require('openai');
    _openrouter = new OpenAI({
      apiKey:  process.env.OPENROUTER_API_KEY,
      baseURL: 'https://openrouter.ai/api/v1',
      defaultHeaders: {
        'HTTP-Referer': 'https://unlmtdwholesale.up.railway.app',
        'X-Title':      'UNLMTD Wholesale',
      },
    });
    console.log('AI: OpenRouter ready');
  }
} catch(e) { console.warn('AI: OpenRouter unavailable:', e.message); }

try {
  if (process.env.OPENAI_API_KEY) {
    const { OpenAI } = require('openai');
    _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    console.log('AI: OpenAI ready');
  }
} catch(e) { console.warn('AI: OpenAI unavailable:', e.message); }

try {
  if (process.env.ANTHROPIC_API_KEY) {
    const Anthropic = require('@anthropic-ai/sdk');
    _anthropic = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });
    console.log('AI: Anthropic ready');
  }
} catch(e) { console.warn('AI: Anthropic unavailable:', e.message); }

// ── GOOGLE SHEETS ─────────────────────────────────────────
let _sheets = null;
try {
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON && process.env.GOOGLE_SHEETS_ID) {
    const { google } = require('googleapis');
    const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    const auth  = new google.auth.GoogleAuth({ credentials: creds, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
    _sheets = google.sheets({ version: 'v4', auth });
    console.log('Sheets: ready');
  } else {
    console.warn('Sheets: GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_SHEETS_ID not set — sync disabled');
  }
} catch(e) { console.warn('Sheets: init failed:', e.message); }

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname)));

// ── DATABASE ──────────────────────────────────────────────
const dbUrl = process.env.DATABASE_URL || process.env.DATABASE_PUBLIC_URL || null;

function maskDbUrl(url){
  try{
    if(!url) return 'NONE';
    const u = new URL(url);
    if(u.password) u.password = '****';
    return u.toString();
  }catch(e){
    return 'UNPARSEABLE';
  }
}

const pool = new Pool({
  connectionString: dbUrl || undefined,
  ssl: { rejectUnauthorized: false },
});

async function waitForDb(retries = 8, delayMs = 1000) {
  for (let i = 0; i < retries; i++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (err) {
      console.error(`DB connect attempt ${i + 1}/${retries} failed:`, err && err.code ? err.code : err.message || err);
      await new Promise(r => setTimeout(r, delayMs * (i + 1)));
    }
  }
  throw new Error('Unable to connect to DB after multiple attempts');
}

async function initDB() {
  // items table: source of truth for catalog entries
  await pool.query(`
    CREATE TABLE IF NOT EXISTS items (
      id SERIAL PRIMARY KEY,
      category TEXT NOT NULL,
      sub TEXT,
      data JSONB NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // simple admin sessions table for token-based auth
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_sessions (
      token TEXT PRIMARY KEY,
      expires_at TIMESTAMP NOT NULL
    );
  `);

  // legacy cache table (optional backup/export)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS catalog_data (
      id INTEGER PRIMARY KEY DEFAULT 1,
      data JSONB NOT NULL,
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // CRM: customers
  await pool.query(`
    CREATE TABLE IF NOT EXISTS customers (
      id          SERIAL PRIMARY KEY,
      whatsapp    TEXT UNIQUE NOT NULL,
      name        TEXT,
      email       TEXT,
      address     TEXT,
      city        TEXT,
      notes       TEXT,
      sheets_row  INTEGER,
      created_at  TIMESTAMP DEFAULT NOW(),
      updated_at  TIMESTAMP DEFAULT NOW()
    );
  `);

  // CRM: conversation threads
  await pool.query(`
    CREATE TABLE IF NOT EXISTS conversations (
      id           SERIAL PRIMARY KEY,
      customer_id  INTEGER REFERENCES customers(id) ON DELETE SET NULL,
      whatsapp     TEXT NOT NULL,
      messages     JSONB NOT NULL DEFAULT '[]',
      state        TEXT NOT NULL DEFAULT 'collecting',
      collected    JSONB NOT NULL DEFAULT '{}',
      bot_active   BOOLEAN NOT NULL DEFAULT TRUE,
      created_at   TIMESTAMP DEFAULT NOW(),
      updated_at   TIMESTAMP DEFAULT NOW()
    );
  `);

  // orders table: customer order tracking by supplier shipping code
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      customer TEXT,
      summary TEXT,
      img TEXT,
      stage INTEGER NOT NULL DEFAULT 0,
      eta TEXT,
      notes TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);
}

// Cleanup expired admin sessions
async function cleanExpiredSessions() {
  try {
    await pool.query('DELETE FROM admin_sessions WHERE expires_at <= NOW()');
  } catch (err) {
    console.error('Session cleanup error', err.message);
  }
}

// Basic validation helpers
function validateItemPayload(obj) {
  if (!obj || typeof obj !== 'object') return 'Payload must be an object';
  if (!obj.category || typeof obj.category !== 'string') return 'Missing or invalid "category"';
  if (!obj.data || typeof obj.data !== 'object') return 'Missing or invalid "data"';
  if ('name' in obj.data && typeof obj.data.name !== 'string') return 'Item.name must be a string';
  if ('price' in obj.data) {
    const p = Number(obj.data.price);
    if (Number.isNaN(p)) return 'Item.price must be a number';
  }
  return null;
}


// ── AUTH MIDDLEWARE ───────────────────────────────────────
// Admin middleware: accept x-admin-token (preferred) or fallback to raw password header
async function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (token) {
    try {
      const r = await pool.query('SELECT token FROM admin_sessions WHERE token = $1 AND expires_at > NOW()', [token]);
      if (r.rows.length === 1) return next();
      return res.status(401).json({ error: 'Invalid token' });
    } catch (err) {
      console.error('Token check error', err.message);
      return res.status(500).json({ error: 'Server error' });
    }
  }
  // fallback to password header for compatibility
  const pw = req.headers['x-admin-password'];
  if (pw && pw === process.env.ADMIN_PASSWORD) return next();
  return res.status(401).json({ error: 'Unauthorized' });
}

// ── ROUTES ────────────────────────────────────────────────

// Serve the catalog
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'ecatalog.html'));
});

// Load catalog (public)
// Public: return full catalog grouped by categories
app.get('/api/catalog', async (req, res) => {
  try {
    const r = await pool.query('SELECT id, category, data, created_at FROM items ORDER BY id');
    const out = {};
    r.rows.forEach(row => {
      const cat = row.category;
      if (!out[cat]) out[cat] = [];
      const item = Object.assign({ id: row.id, _createdAt: row.created_at }, row.data);
      out[cat].push(item);
    });
    return res.json(out);
  } catch (err) {
    console.error('Load error:', err.message);
    return res.status(500).json({ error: 'Failed to load catalog' });
  }
});

// Save catalog (admin only)
// Save entire catalog (admin): replace items with provided structure
app.post('/api/catalog', requireAdmin, async (req, res) => {
  const payload = req.body || {};
  try {
    // basic validation of structure
    if (typeof payload !== 'object' || Array.isArray(payload)) return res.status(400).json({ error: 'Invalid catalog payload' });
    for (const [cat, arr] of Object.entries(payload)) {
      if (!Array.isArray(arr)) return res.status(400).json({ error: `Category ${cat} must contain an array` });
      for (const it of arr) {
        const v = validateItemPayload(Object.assign({ category: cat }, { data: it }));
        if (v) return res.status(400).json({ error: v });
      }
    }

    await pool.query('BEGIN');
    // clear items
    await pool.query('DELETE FROM items');
    // insert items from each category
    const insertText = 'INSERT INTO items (category, sub, data) VALUES ($1, $2, $3)';
    for (const [category, arr] of Object.entries(payload)) {
      for (const it of (arr || [])) {
        const sub = it.sub || null;
        await pool.query(insertText, [category, sub, it]);
      }
    }
    // update legacy cache
    await pool.query(`INSERT INTO catalog_data (id, data, updated_at) VALUES (1, $1, NOW()) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`, [payload]);
    await pool.query('COMMIT');
    return res.json({ success: true });
  } catch (err) {
    await pool.query('ROLLBACK');
    console.error('Save error:', err.message);
    return res.status(500).json({ error: 'Failed to save catalog' });
  }
});

// --- Per-item CRUD ---
// List items (flat)
app.get('/api/items', async (req, res) => {
  try {
    const r = await pool.query('SELECT id, category, sub, data FROM items ORDER BY id');
    const rows = r.rows.map(row => Object.assign({ id: row.id, category: row.category, sub: row.sub }, row.data));
    return res.json(rows);
  } catch (err) {
    console.error('GET /api/items error', err.message);
    return res.status(500).json({ error: 'Failed' });
  }
});

// Create item
app.post('/api/items', requireAdmin, async (req, res) => {
  const { category, sub, data } = req.body || {};
  const v = validateItemPayload({ category, data });
  if (v) return res.status(400).json({ error: v });
  try {
    const r = await pool.query('INSERT INTO items (category, sub, data) VALUES ($1, $2, $3) RETURNING id', [category, sub || null, data]);
    return res.status(201).json({ id: r.rows[0].id });
  } catch (err) {
    console.error('POST /api/items error', err.message);
    return res.status(500).json({ error: 'Failed' });
  }
});

// Update item
app.put('/api/items/:id', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { category, sub, data } = req.body || {};
  const v = validateItemPayload({ category, data });
  if (!id || v) return res.status(400).json({ error: !id ? 'Missing id' : v });
  try {
    await pool.query('UPDATE items SET category = $1, sub = $2, data = $3, updated_at = NOW() WHERE id = $4', [category, sub || null, data, id]);
    return res.json({ success: true });
  } catch (err) {
    console.error('PUT /api/items error', err.message);
    return res.status(500).json({ error: 'Failed' });
  }
});

// Delete item
app.delete('/api/items/:id', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'Missing id' });
  try {
    await pool.query('DELETE FROM items WHERE id = $1', [id]);
    return res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/items error', err.message);
    return res.status(500).json({ error: 'Failed' });
  }
});

// Login: exchange password for a short-lived token
app.post('/api/login', async (req, res) => {
  const { password } = req.body || {};
  if (!password || password !== process.env.ADMIN_PASSWORD) return res.status(401).json({ error: 'Wrong password' });
  try {
    const token = require('crypto').randomBytes(24).toString('hex');
    const expires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h
    await pool.query('INSERT INTO admin_sessions (token, expires_at) VALUES ($1, $2)', [token, expires]);
    return res.json({ token, expiresAt: expires.toISOString() });
  } catch (err) {
    console.error('Login error', err.message);
    return res.status(500).json({ error: 'Failed' });
  }
});

// Validate token/password (used by client to check stored session)
app.get('/api/validate', requireAdmin, async (req, res) => {
  return res.json({ ok: true });
});

// Logout / revoke a token
app.post('/api/logout', async (req, res) => {
  const token = req.headers['x-admin-token'] || (req.body && req.body.token);
  // If no token provided, allow password-based revoke (admin wants to clear all?)
  if (!token) {
    const pw = req.headers['x-admin-password'] || (req.body && req.body.password);
    if (!pw || pw !== process.env.ADMIN_PASSWORD) return res.status(400).json({ error: 'Missing token or valid password' });
    try {
      await pool.query('DELETE FROM admin_sessions');
      return res.json({ success: true });
    } catch (err) {
      console.error('Logout error', err.message);
      return res.status(500).json({ error: 'Failed' });
    }
  }
  try {
    await pool.query('DELETE FROM admin_sessions WHERE token = $1', [token]);
    return res.json({ success: true });
  } catch (err) {
    console.error('Logout error', err.message);
    return res.status(500).json({ error: 'Failed' });
  }
});

// ── ORDER TRACKING ────────────────────────────────────────
function normalizeCode(code) {
  return String(code || '').trim().toUpperCase();
}

// Public: look up an order by its shipping code (no auth)
app.get('/api/track/:code', async (req, res) => {
  const code = normalizeCode(req.params.code);
  if (!code) return res.status(400).json({ error: 'Missing code' });
  try {
    const r = await pool.query(
      'SELECT code, customer, summary, img, stage, eta, notes, updated_at FROM orders WHERE UPPER(code) = $1',
      [code]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    const o = r.rows[0];
    return res.json({
      code: o.code, customer: o.customer, summary: o.summary, img: o.img,
      stage: o.stage, eta: o.eta, notes: o.notes, updatedAt: o.updated_at,
    });
  } catch (err) {
    console.error('Track error', err.message);
    return res.status(500).json({ error: 'Failed' });
  }
});

// Admin: list all orders
app.get('/api/orders', requireAdmin, async (req, res) => {
  try {
    const r = await pool.query('SELECT id, code, customer, summary, img, stage, eta, notes, created_at, updated_at FROM orders ORDER BY updated_at DESC');
    return res.json(r.rows);
  } catch (err) {
    console.error('GET /api/orders error', err.message);
    return res.status(500).json({ error: 'Failed' });
  }
});

// Admin: create order
app.post('/api/orders', requireAdmin, async (req, res) => {
  const { code, customer, summary, img, stage, eta, notes } = req.body || {};
  const c = normalizeCode(code);
  if (!c) return res.status(400).json({ error: 'Missing code' });
  try {
    const r = await pool.query(
      `INSERT INTO orders (code, customer, summary, img, stage, eta, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [c, customer || null, summary || null, img || null, parseInt(stage, 10) || 0, eta || null, notes || null]
    );
    return res.status(201).json({ id: r.rows[0].id });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Code already exists' });
    console.error('POST /api/orders error', err.message);
    return res.status(500).json({ error: 'Failed' });
  }
});

// Admin: update order
app.put('/api/orders/:id', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { code, customer, summary, img, stage, eta, notes } = req.body || {};
  const c = normalizeCode(code);
  if (!id || !c) return res.status(400).json({ error: !id ? 'Missing id' : 'Missing code' });
  try {
    await pool.query(
      `UPDATE orders SET code=$1, customer=$2, summary=$3, img=$4, stage=$5, eta=$6, notes=$7, updated_at=NOW() WHERE id=$8`,
      [c, customer || null, summary || null, img || null, parseInt(stage, 10) || 0, eta || null, notes || null, id]
    );
    return res.json({ success: true });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Code already exists' });
    console.error('PUT /api/orders error', err.message);
    return res.status(500).json({ error: 'Failed' });
  }
});

// Admin: delete order
app.delete('/api/orders/:id', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'Missing id' });
  try {
    await pool.query('DELETE FROM orders WHERE id = $1', [id]);
    return res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/orders error', err.message);
    return res.status(500).json({ error: 'Failed' });
  }
});

// ── AI ABSTRACTION ────────────────────────────────────────
const AI_SYSTEM_PROMPT = `You are the AI assistant for UNLMTD Wholesale Supply Co., a clothing and accessories wholesale business in the Bahamas. Your job is to collect order information from customers via WhatsApp in a friendly, professional way.

Collect in this order (skip already-collected fields):
1. Customer name
2. What item(s) they want (they can browse the catalog at https://unlmtdwholesale.up.railway.app)
3. Size(s) needed
4. Email address
5. Shipping address and city

Rules:
- Be warm, concise, and on-brand. Don't be robotic.
- If the customer asks about price negotiation, bulk discounts, complaints, customs, or anything you can't answer confidently → set needs_human: true
- Never invent prices or shipping costs
- Once all 5 fields are collected, thank them and say the team will confirm their order shortly

Always respond with valid JSON only:
{ "reply": "your message text", "collected": { "name": null, "item": null, "size": null, "email": null, "address": null, "city": null }, "needs_human": false }

Only include fields in "collected" that you are extracting FROM THIS specific message. Omit fields not mentioned.`;

async function callAI(conversationMessages) {
  const provider = (process.env.AI_PROVIDER || 'openrouter').toLowerCase();
  const msgs = conversationMessages.map(m => ({ role: m.role, content: m.content }));

  // OpenRouter (default — free models available)
  if (provider === 'openrouter' && _openrouter) {
    const resp = await _openrouter.chat.completions.create({
      model: process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.1-8b-instruct:free',
      max_tokens: 512,
      messages: [{ role: 'system', content: AI_SYSTEM_PROMPT }, ...msgs],
    });
    return JSON.parse(resp.choices[0].message.content);
  }

  // OpenAI fallback
  if (provider === 'openai' && _openai) {
    const resp = await _openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      max_tokens: 512,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: AI_SYSTEM_PROMPT }, ...msgs],
    });
    return JSON.parse(resp.choices[0].message.content);
  }

  // Claude fallback
  if (provider === 'claude' && _anthropic) {
    const resp = await _anthropic.messages.create({
      model: process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5',
      max_tokens: 512,
      system: AI_SYSTEM_PROMPT,
      messages: msgs,
    });
    return JSON.parse(resp.content[0].text);
  }

  throw new Error('No AI provider configured. Set OPENROUTER_API_KEY, OPENAI_API_KEY, or ANTHROPIC_API_KEY.');
}

// ── WHATSAPP HELPERS ──────────────────────────────────────
async function sendWhatsAppMessage(to, text) {
  const pid = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const tok = process.env.WHATSAPP_ACCESS_TOKEN;
  if (!pid || !tok) { console.warn('WhatsApp: credentials not set, skipping send'); return; }

  const body = JSON.stringify({
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body: text },
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'graph.facebook.com',
      path: `/v19.0/${pid}/messages`,
      method: 'POST',
      headers: { 'Authorization': `Bearer ${tok}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => { res.resume(); resolve(); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── GOOGLE SHEETS SYNC ────────────────────────────────────
const SHEETS_ID = process.env.GOOGLE_SHEETS_ID;

async function syncCustomerToSheets(customer) {
  if (!_sheets || !SHEETS_ID) return;
  try {
    const row = [
      customer.whatsapp, customer.name || '', customer.email || '',
      customer.address || '', customer.city || '', customer.notes || '',
      customer.created_at ? new Date(customer.created_at).toLocaleDateString() : '',
      new Date().toLocaleDateString(),
    ];
    if (customer.sheets_row) {
      await _sheets.spreadsheets.values.update({
        spreadsheetId: SHEETS_ID,
        range: `Customers!A${customer.sheets_row}`,
        valueInputOption: 'RAW',
        requestBody: { values: [row] },
      });
    } else {
      const res = await _sheets.spreadsheets.values.append({
        spreadsheetId: SHEETS_ID,
        range: 'Customers!A1',
        valueInputOption: 'RAW',
        requestBody: { values: [row] },
      });
      const updatedRange = res.data.updates.updatedRange;
      const rowNum = parseInt(updatedRange.match(/\d+$/)?.[0]);
      if (rowNum) {
        await pool.query('UPDATE customers SET sheets_row=$1 WHERE id=$2', [rowNum, customer.id]);
      }
    }
  } catch (e) { console.warn('Sheets sync error:', e.message); }
}

async function syncOrderToSheets(order) {
  if (!_sheets || !SHEETS_ID) return;
  try {
    await _sheets.spreadsheets.values.append({
      spreadsheetId: SHEETS_ID,
      range: 'Orders!A1',
      valueInputOption: 'RAW',
      requestBody: { values: [[
        order.code, order.customer || '', order.summary || '',
        String(order.stage || 0), order.eta || '',
        order.created_at ? new Date(order.created_at).toLocaleDateString() : '',
      ]] },
    });
  } catch (e) { console.warn('Sheets order sync error:', e.message); }
}

// ── WHATSAPP CONVERSATION ENGINE ──────────────────────────
async function handleIncoming(from, text) {
  try {
    // Upsert customer
    let custRes = await pool.query(
      `INSERT INTO customers (whatsapp) VALUES ($1)
       ON CONFLICT (whatsapp) DO UPDATE SET updated_at=NOW()
       RETURNING *`, [from]
    );
    const customer = custRes.rows[0];

    // Load or create conversation
    let convRes = await pool.query(
      `SELECT * FROM conversations WHERE whatsapp=$1 AND state != 'closed' ORDER BY id DESC LIMIT 1`,
      [from]
    );
    let conv;
    if (convRes.rows.length === 0) {
      const r = await pool.query(
        `INSERT INTO conversations (customer_id, whatsapp, messages, collected) VALUES ($1,$2,'[]','{}') RETURNING *`,
        [customer.id, from]
      );
      conv = r.rows[0];
    } else {
      conv = convRes.rows[0];
    }

    // Append incoming message
    const messages = conv.messages || [];
    messages.push({ role: 'user', content: text, ts: Date.now() });

    // If bot is off, just save
    if (!conv.bot_active) {
      await pool.query(
        `UPDATE conversations SET messages=$1, updated_at=NOW() WHERE id=$2`,
        [JSON.stringify(messages), conv.id]
      );
      return;
    }

    // Call AI
    let aiResult;
    try {
      aiResult = await callAI(messages.map(m => ({ role: m.role, content: m.content })));
    } catch (aiErr) {
      console.error('AI error:', aiErr.message);
      await sendWhatsAppMessage(from, "Sorry, I'm having a moment — the team will be with you shortly!");
      await pool.query(
        `UPDATE conversations SET messages=$1, state='needs_human', updated_at=NOW() WHERE id=$2`,
        [JSON.stringify(messages), conv.id]
      );
      return;
    }

    const reply     = aiResult.reply || '';
    const newFields = aiResult.collected || {};
    const needsHuman = !!aiResult.needs_human;

    // Merge collected fields
    const collected = Object.assign({}, conv.collected || {});
    Object.keys(newFields).forEach(k => { if (newFields[k]) collected[k] = newFields[k]; });

    // Update customer record with newly collected info
    const updates = [];
    if (collected.name)    updates.push(pool.query('UPDATE customers SET name=$1,    updated_at=NOW() WHERE id=$2', [collected.name,    customer.id]));
    if (collected.email)   updates.push(pool.query('UPDATE customers SET email=$1,   updated_at=NOW() WHERE id=$2', [collected.email,   customer.id]));
    if (collected.address) updates.push(pool.query('UPDATE customers SET address=$1, updated_at=NOW() WHERE id=$2', [collected.address, customer.id]));
    if (collected.city)    updates.push(pool.query('UPDATE customers SET city=$1,    updated_at=NOW() WHERE id=$2', [collected.city,    customer.id]));
    await Promise.all(updates);

    // Append AI reply
    messages.push({ role: 'assistant', content: reply, ts: Date.now() });

    // Determine new state
    const allCollected = collected.name && collected.item && collected.size && collected.email && collected.address;
    const newState = needsHuman ? 'needs_human' : (allCollected ? 'closed' : 'collecting');

    await pool.query(
      `UPDATE conversations SET messages=$1, state=$2, collected=$3, updated_at=NOW() WHERE id=$4`,
      [JSON.stringify(messages), newState, JSON.stringify(collected), conv.id]
    );

    // Send reply
    await sendWhatsAppMessage(from, reply);

    // Sync to Sheets
    const updatedCust = (await pool.query('SELECT * FROM customers WHERE id=$1', [customer.id])).rows[0];
    await syncCustomerToSheets(updatedCust);

  } catch (err) {
    console.error('handleIncoming error:', err.message);
  }
}

// ── WHATSAPP WEBHOOK ──────────────────────────────────────
app.get('/api/whatsapp/webhook', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  res.status(403).end();
});

app.post('/api/whatsapp/webhook', (req, res) => {
  res.status(200).end(); // ACK immediately to Meta
  try {
    const entry   = req.body?.entry?.[0];
    const changes = entry?.changes?.[0]?.value;
    const message = changes?.messages?.[0];
    if (!message || message.type !== 'text') return;
    const from = message.from;
    const text = message.text?.body || '';
    if (from && text) handleIncoming(from, text).catch(e => console.error('webhook handler:', e.message));
  } catch (e) { console.error('webhook parse error:', e.message); }
});

// ── CRM ADMIN ENDPOINTS ───────────────────────────────────

// List customers
app.get('/api/customers', requireAdmin, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT c.*,
        (SELECT state FROM conversations WHERE customer_id=c.id ORDER BY id DESC LIMIT 1) AS conv_state,
        (SELECT updated_at FROM conversations WHERE customer_id=c.id ORDER BY id DESC LIMIT 1) AS last_activity
      FROM customers c ORDER BY c.updated_at DESC
    `);
    return res.json(r.rows);
  } catch (e) { console.error('GET /api/customers', e.message); return res.status(500).json({ error: 'Failed' }); }
});

// Get single customer + conversations
app.get('/api/customers/:id', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'Bad id' });
  try {
    const cust = (await pool.query('SELECT * FROM customers WHERE id=$1', [id])).rows[0];
    if (!cust) return res.status(404).json({ error: 'Not found' });
    const convs = (await pool.query('SELECT * FROM conversations WHERE customer_id=$1 ORDER BY id DESC', [id])).rows;
    return res.json({ ...cust, conversations: convs });
  } catch (e) { console.error('GET /api/customers/:id', e.message); return res.status(500).json({ error: 'Failed' }); }
});

// Update customer
app.put('/api/customers/:id', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { name, email, address, city, notes } = req.body || {};
  if (!id) return res.status(400).json({ error: 'Bad id' });
  try {
    await pool.query(
      'UPDATE customers SET name=$1,email=$2,address=$3,city=$4,notes=$5,updated_at=NOW() WHERE id=$6',
      [name||null, email||null, address||null, city||null, notes||null, id]
    );
    const updated = (await pool.query('SELECT * FROM customers WHERE id=$1', [id])).rows[0];
    await syncCustomerToSheets(updated);
    return res.json({ success: true });
  } catch (e) { console.error('PUT /api/customers/:id', e.message); return res.status(500).json({ error: 'Failed' }); }
});

// List conversations (optionally filter by state)
app.get('/api/conversations', requireAdmin, async (req, res) => {
  try {
    const state = req.query.state;
    const r = state
      ? await pool.query('SELECT * FROM conversations WHERE state=$1 ORDER BY updated_at DESC', [state])
      : await pool.query('SELECT * FROM conversations ORDER BY updated_at DESC LIMIT 100');
    return res.json(r.rows);
  } catch (e) { console.error('GET /api/conversations', e.message); return res.status(500).json({ error: 'Failed' }); }
});

// Toggle bot on/off for a conversation
app.put('/api/conversations/:id/bot', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { bot_active } = req.body || {};
  if (!id || bot_active === undefined) return res.status(400).json({ error: 'Bad request' });
  try {
    await pool.query('UPDATE conversations SET bot_active=$1, updated_at=NOW() WHERE id=$2', [!!bot_active, id]);
    return res.json({ success: true });
  } catch (e) { console.error('PUT /api/conversations/:id/bot', e.message); return res.status(500).json({ error: 'Failed' }); }
});

// Send manual reply as admin
app.post('/api/conversations/:id/reply', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { text } = req.body || {};
  if (!id || !text) return res.status(400).json({ error: 'Missing text' });
  try {
    const conv = (await pool.query('SELECT * FROM conversations WHERE id=$1', [id])).rows[0];
    if (!conv) return res.status(404).json({ error: 'Not found' });
    const messages = conv.messages || [];
    messages.push({ role: 'assistant', content: text, ts: Date.now() });
    await pool.query(
      'UPDATE conversations SET messages=$1, updated_at=NOW() WHERE id=$2',
      [JSON.stringify(messages), id]
    );
    await sendWhatsAppMessage(conv.whatsapp, text);
    return res.json({ success: true });
  } catch (e) { console.error('POST /api/conversations/:id/reply', e.message); return res.status(500).json({ error: 'Failed' }); }
});

// Image proxy — bypasses hotlink protection for known supplier domains
const IMG_ALLOWED = /^https?:\/\/([a-z0-9-]+\.)?(yupoo\.com|qiqiyg\.com|alicdn\.com|dhgate\.com|aliexpress\.com|richeng86888\.ru)/i;

app.get('/api/img', (req, res) => {
  const url = decodeURIComponent(req.query.url || '');
  if (!url || !IMG_ALLOWED.test(url)) return res.status(403).end();

  // Derive a Yupoo-native referer from the image URL
  let referer = 'https://www.yupoo.com/';
  const m = url.match(/photo\.yupoo\.com\/([^/]+)\//);
  if (m) referer = `https://${m[1]}.x.yupoo.com/`;

  const options = {
    headers: {
      'Referer':    referer,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    },
  };

  const proto = url.startsWith('https') ? https : http;
  proto.get(url, options, (imgRes) => {
    const ct = imgRes.headers['content-type'] || '';
    if (!ct.startsWith('image/')) { imgRes.resume(); return res.status(403).end(); }
    res.setHeader('Content-Type', ct);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    imgRes.pipe(res);
  }).on('error', () => res.status(502).end());
});

// Validate admin password
app.post('/api/auth', (req, res) => {
  const { password } = req.body;
  if (password && password === process.env.ADMIN_PASSWORD) {
    res.json({ success: true });
  } else {
    res.status(401).json({ error: 'Wrong password' });
  }
});

// ── CATALOG CONFIG (shared) ──────────────────────────────
const CATEGORIES = [
  { id: 'mens',    label: "Menswear",         icon: "👔", subs: ["T-Shirts", "Shirts & Polos", "Hoodies & Sweats", "Jackets & Outerwear", "Suits & Formal"] },
  { id: 'womens',  label: "Womenswear",       icon: "👗", subs: ["Tops & Blouses", "Dresses", "Sets & Co-ords", "Skirts", "Activewear"] },
  { id: 'jeans',   label: "Bottoms",          icon: "👖", subs: ["Jeans", "Cargo & Utility", "Shorts", "Joggers & Sweats", "Dress Pants"] },
  { id: 'shoes',   label: "Footwear",         icon: "👟", subs: ["Sneakers", "Boots", "Dress Shoes", "Heels", "Loafers & Casual"] },
  { id: 'slides',  label: "Slides & Sandals", icon: "🩴", subs: ["Foam Slides", "Strap Sandals", "Platform", "House Slippers", "Beach Sandals"] },
  { id: 'bags',    label: "Bags",             icon: "👜", subs: ["Crossbody", "Backpacks", "Totes & Shoppers", "Wallets & Belts", "Hats & Caps"] },
  { id: 'watches', label: "Watches",          icon: "⌚", subs: ["Everyday", "Sport & Fitness", "Dress & Formal", "Smart & Digital", "Women's Watches"] },
  { id: 'eyewear', label: "Eyewear",          icon: "🕶️", subs: ["Sunglasses", "Fashion Frames", "Sport Shades", "Reading Glasses", "Blue Light"] },
];
const WA_NUMBER = '12427270271';

// ── HTMX CATALOG RENDERING ─────────────────────────────────

function escHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function proxyImgUrl(url) {
  if (!url) return url;
  if (url.match(/yupoo\.com|richeng86888\.ru/i)) return '/api/img?url=' + encodeURIComponent(url);
  return url;
}

function renderProductCard(item, catId) {
  const imgs = item.imgs && item.imgs.length ? item.imgs : (item.img ? [item.img] : []);
  const itemJson = JSON.stringify(item).replace(/'/g, '&#39;').replace(/"/g, '&quot;');
  const waMsg = encodeURIComponent(`Hi! I'm interested in ordering:\n\n*${item.name}*\n${item.desc}${item.price ? '\nPrice: $' + item.price + ' BSD' : ''}\n${item.sizes ? 'Sizes: ' + item.sizes : ''}\n\nCould you send me more details?`);
  const waUrl = `https://wa.me/${WA_NUMBER}?text=${waMsg}`;
  const isNew = item._createdAt && (Date.now() - new Date(item._createdAt).getTime()) < 14 * 864e5;
  const priceHtml = item.por
    ? `<div class="card-price-por">📲 Contact for Price</div>`
    : `<div><div class="card-price">$${item.price}<span>BSD</span></div>${item.bulkPrice ? `<div class="bulk-price-tag">Bulk<span>$${item.bulkPrice}</span></div>` : ''}</div>`;

  let imgContent = '';
  if (imgs.length === 0) {
    imgContent = `<div class="card-img-placeholder"><div class="placeholder-icon">${item.icon || '🏷️'}</div><div class="placeholder-text">Tap to add image</div></div>`;
  } else if (imgs.length === 1) {
    const esc = imgs[0].replace(/'/g, '%27');
    imgContent = `<img class="card-img" src="${proxyImgUrl(imgs[0])}" alt="${escHtml(item.name)}" style="cursor:zoom-in;" onclick="event.stopPropagation();openLightbox(['${esc}'],0)" onerror="this.style.display='none';this.insertAdjacentHTML('afterend','<div class=\\'card-img-placeholder\\'><div class=\\'placeholder-icon\\'>${item.icon||'🏷️'}</div><div class=\\'placeholder-text\\'>No image</div></div>')">`;
  } else {
    const imgsJson = JSON.stringify(imgs).replace(/'/g, '%27');
    const slides = imgs.map((src, i) => `<img class="carousel-slide" src="${proxyImgUrl(src)}" alt="${escHtml(item.name)}" style="cursor:zoom-in;" onclick="event.stopPropagation();openLightbox(JSON.parse(this.closest('.card-carousel').dataset.imgs),${i})" onerror="this.style.opacity='0.15'">`).join('');
    const dots = imgs.map((_, i) => `<span class="carousel-dot${i === 0 ? ' active' : ''}"></span>`).join('');
    imgContent = `<div class="card-carousel" data-idx="0" data-count="${imgs.length}" data-imgs='${imgsJson}' ontouchstart="carouselTouch(this,event,'start')" ontouchend="carouselTouch(this,event,'end')"><div class="carousel-track">${slides}</div><button class="carousel-prev" onclick="event.stopPropagation();carouselMove(this.parentElement,-1)">‹</button><button class="carousel-next" onclick="event.stopPropagation();carouselMove(this.parentElement,1)">›</button><div class="carousel-dots">${dots}</div><div class="photo-count">📷 ${imgs.length}</div></div>`;
  }

  const badgeRibbon = item.badge ? `<span class="card-badge">${escHtml(item.badge)}</span>` : '';
  const newRibbon = isNew ? `<span class="card-new">NEW</span>` : '';
  const soldOutOverlay = item.soldOut ? `<div class="card-sold-out"><div class="sold-out-banner">SOLD OUT</div></div>` : '';
  const actionsClass = item.soldOut ? 'card-actions is-sold-out' : 'card-actions';
  const supplierBtn = item.supplierLink ? `<button class="card-action-btn btn-supplier" onclick="event.stopPropagation();window.open('${escHtml(item.supplierLink)}','_blank')" title="Supplier link">🔗</button>` : '';

  return `<div class="product-card" data-cat="${catId}" data-id="${item.id || ''}" data-item='${itemJson}' onclick="if(document.body.classList.contains('admin-mode'))openModal(this.dataset.cat,this.dataset.id)">
    ${imgContent}
    ${badgeRibbon}
    ${newRibbon}
    ${soldOutOverlay}
    <div class="card-overlay"><button class="order-btn">✏️ Edit</button></div>
    <div class="card-body">
      <div class="card-name">${escHtml(item.name)}</div>
      <div class="card-desc">${escHtml(item.desc)}</div>
      <div class="card-footer">
        ${priceHtml}
        ${item.sizes ? `<div class="card-sizes">${escHtml(item.sizes)}</div>` : ''}
      </div>
    </div>
    <div class="${actionsClass}" onclick="event.stopPropagation()">
      <a class="card-action-btn btn-wa" href="${waUrl}" target="_blank">📲 WhatsApp</a>
      <button class="card-action-btn btn-copy" onclick="copyItem(this)">📋 Copy</button>
      ${supplierBtn}
    </div>
  </div>`;
}

function renderCategoryGrid(cat, items, activeSub, sort) {
  let filtered = [...items];
  if (activeSub) filtered = items.filter(it => it.sub === activeSub);
  if (sort === 'price-asc')  filtered.sort((a, b) => (parseFloat(a.price) || 0) - (parseFloat(b.price) || 0));
  if (sort === 'price-desc') filtered.sort((a, b) => (parseFloat(b.price) || 0) - (parseFloat(a.price) || 0));
  if (sort === 'name-asc')   filtered.sort((a, b) => (a.name || '').localeCompare(b.name || ''));

  const subQs = activeSub ? '?sub=' + encodeURIComponent(activeSub) : '';
  const sortQs = sort ? (subQs ? '&sort=' + sort : '?sort=' + sort) : subQs;

  let html = `<div class="cat-header">
    <div class="cat-title">${cat.icon} ${cat.label}</div>
    <div style="display:flex;align-items:center;gap:12px;">
      <div class="cat-count">${items.length} items</div>
      <select class="sort-select" name="sort" hx-get="/catalog/${cat.id}${subQs}" hx-target="#grid-container" hx-swap="innerHTML" hx-trigger="change">
        <option value="" ${!sort ? 'selected' : ''}>Default</option>
        <option value="price-asc" ${sort === 'price-asc' ? 'selected' : ''}>Price ↑</option>
        <option value="price-desc" ${sort === 'price-desc' ? 'selected' : ''}>Price ↓</option>
        <option value="name-asc" ${sort === 'name-asc' ? 'selected' : ''}>A – Z</option>
      </select>
    </div>
  </div>
  <div class="sub-filter-wrap">
    <div class="sub-pill ${!activeSub ? 'active' : ''}" hx-get="/catalog/${cat.id}${sortQs}" hx-target="#grid-container" hx-swap="innerHTML">All</div>`;

  for (const sub of cat.subs) {
    const subCount = items.filter(it => it.sub === sub).length;
    if (!activeSub || subCount > 0) {
      const subUrl = `/catalog/${cat.id}?sub=${encodeURIComponent(sub)}${sort ? '&sort=' + sort : ''}`;
      html += `<div class="sub-pill ${activeSub === sub ? 'active' : ''}" hx-get="${subUrl}" hx-target="#grid-container" hx-swap="innerHTML">${sub}</div>`;
    }
  }
  html += `</div>`;

  if (filtered.length === 0) {
    html += `<div style="text-align:center;padding:60px 20px;"><div style="font-family:'Barlow Condensed',sans-serif;font-size:13px;letter-spacing:2px;text-transform:uppercase;color:var(--text-dim);">No items in this category yet.</div></div>`;
  } else {
    // Group by sub for section headers
    if (!activeSub) {
      for (const sub of cat.subs) {
        const subItems = filtered.filter(it => it.sub === sub);
        if (!subItems.length) continue;
        html += `<div class="sub-section-header">${sub} <span>${subItems.length} item${subItems.length !== 1 ? 's' : ''}</span></div>`;
        html += `<div class="product-grid" style="margin-bottom:8px;">${subItems.map(item => renderProductCard(item, cat.id)).join('')}<div class="add-card product-card" onclick="event.stopPropagation();openModal('${cat.id}',null,'${sub.replace(/'/g, "\\'")}')"><div class="add-icon">＋</div><div class="add-label">Add to ${sub}</div></div></div>`;
      }
      // orphans
      const orphans = filtered.filter(it => !cat.subs.includes(it.sub));
      if (orphans.length) {
        html += `<div class="sub-section-header">More <span>${orphans.length} item${orphans.length !== 1 ? 's' : ''}</span></div>`;
        html += `<div class="product-grid" style="margin-bottom:8px;">${orphans.map(item => renderProductCard(item, cat.id)).join('')}</div>`;
      }
    } else {
      html += `<div class="product-grid" style="margin-bottom:8px;">${filtered.map(item => renderProductCard(item, cat.id)).join('')}<div class="add-card product-card" onclick="event.stopPropagation();openModal('${cat.id}',null,'${(activeSub || '').replace(/'/g, "\\'")}')"><div class="add-icon">＋</div><div class="add-label">Add to ${activeSub}</div></div></div>`;
    }
  }

  // Add new item section for admin
  html += `<div class="admin-section"><div class="sub-section-header" style="margin-top:24px;">Add New Item</div><div class="product-grid" style="margin-bottom:8px;"><div class="add-card product-card" onclick="event.stopPropagation();openModal('${cat.id}',null,null)"><div class="add-icon">＋</div><div class="add-label">Add Item</div></div></div></div>`;

  return html;
}

// ── HTMX CATALOG ROUTES ────────────────────────────────────

app.get('/catalog/:category', async (req, res) => {
  const catId = req.params.category;
  const cat = CATEGORIES.find(c => c.id === catId);
  if (!cat) return res.status(404).send('Category not found');

  const activeSub = req.query.sub || null;
  const sort = req.query.sort || null;

  try {
    const r = await pool.query('SELECT id, category, data, created_at FROM items WHERE category = $1 ORDER BY id', [catId]);
    const items = r.rows.map(row => Object.assign({ id: row.id, _createdAt: row.created_at }, row.data));
    const html = renderCategoryGrid(cat, items, activeSub, sort);
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (err) {
    console.error('GET /catalog/:category error', err.message);
    res.status(500).send('<div style="color:#e05555;text-align:center;padding:40px;">Failed to load catalog.</div>');
  }
});

app.get('/catalog/search', async (req, res) => {
  const q = (req.query.q || '').trim().toLowerCase();
  if (!q) {
    return res.send('<div style="text-align:center;padding:60px 20px;"><div style="font-family:Barlow Condensed,sans-serif;font-size:13px;letter-spacing:2px;text-transform:uppercase;color:var(--text-dim);">Start typing to search...</div></div>');
  }

  try {
    const pattern = `%${q}%`;
    const r = await pool.query(
      `SELECT id, category, data, created_at FROM items
       WHERE LOWER(data->>'name') LIKE $1
          OR LOWER(data->>'desc') LIKE $1
          OR LOWER(data->>'badge') LIKE $1
       ORDER BY id`,
      [pattern]
    );
    if (r.rows.length === 0) {
      return res.send(`<div style="text-align:center;padding:60px 20px;"><div style="font-family:'Barlow Condensed',sans-serif;font-size:13px;letter-spacing:2px;text-transform:uppercase;color:var(--text-dim);">No results for "${escHtml(q)}"</div></div>`);
    }

    // Group by category
    const grouped = {};
    r.rows.forEach(row => {
      const cat = row.category;
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push(Object.assign({ id: row.id, _createdAt: row.created_at }, row.data));
    });

    let html = '';
    for (const [catId, items] of Object.entries(grouped)) {
      const cat = CATEGORIES.find(c => c.id === catId);
      if (!cat) continue;
      html += `<div class="sub-section-header">${cat.icon} ${cat.label} <span>${items.length}</span></div>`;
      html += `<div class="product-grid" style="margin-bottom:8px;">${items.map(item => renderProductCard(item, catId)).join('')}</div>`;
    }
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (err) {
    console.error('GET /catalog/search error', err.message);
    res.status(500).send('<div style="color:#e05555;text-align:center;padding:40px;">Search failed.</div>');
  }
});

// ── BULK ALBUM IMPORTER ────────────────────────────────────

function fetchSupplierPage(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const proto = u.protocol === 'https:' ? https : http;

    let referer = u.origin + '/';
    if (u.hostname.includes('yupoo.com')) {
      const m = u.hostname.match(/^(.+)\.x\.yupoo\.com$/);
      if (m) referer = `https://${m[1]}.x.yupoo.com/`;
      else referer = 'https://www.yupoo.com/';
    }

    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Referer': referer,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7',
      },
    };

    const req = proto.get(url, options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchSupplierPage(res.headers.location).then(resolve).catch(reject);
        return;
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Request timeout')); });
  });
}

// Browser-based Yupoo scraper — handles JS-rendered album pages
async function scrapeYupooBrowser(url, password) {
  const puppeteer = await getPuppeteer();
  if (!puppeteer) throw new Error('Puppeteer not available');

  let browser = null;
  try {
    // Try @sparticuz/chromium first (serverless-friendly), fall back to puppeteer's bundled Chromium
    let launchOpts = {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-web-security',
        '--window-size=1366,768',
        '--single-process',
      ],
    };

    try {
      const sparticuz = require('@sparticuz/chromium');
      launchOpts.args = [...sparticuz.args, '--window-size=1366,768'];
      launchOpts.executablePath = await sparticuz.executablePath();
      launchOpts.headless = sparticuz.headless;
    } catch (_) {
      // @sparticuz/chromium not available, use puppeteer's bundled Chromium (default)
    }

    browser = await puppeteer.launch(launchOpts);

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1366, height: 768 });

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

    // Handle password-protected albums
    if (password) {
      await new Promise(r => setTimeout(r, 1500));
      const locked = await page.evaluate(() => {
        const body = document.body ? document.body.innerText : '';
        return body.includes('Please Enter Password') || body.includes('Encrypted') || !!document.querySelector('input[type="password"]');
      });
      if (locked) {
        // Fill in password and submit
        await page.evaluate((pw) => {
          const input = document.querySelector('input[type="password"]') || document.querySelector('input[type="text"][placeholder*="password" i]') || document.querySelector('input[placeholder*="Password"]');
          if (input) {
            input.value = pw;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            // Find and click submit button
            const btn = document.querySelector('button[type="submit"]') || document.querySelector('button') || document.querySelector('input[type="submit"]');
            // Look for a button that says confirm/submit
            const allBtns = document.querySelectorAll('button, input[type="submit"], input[type="button"]');
            let submitBtn = null;
            allBtns.forEach(b => {
              const t = (b.textContent || b.value || '').toLowerCase();
              if (t.includes('confirm') || t.includes('submit') || t.includes('ok') || t.includes('login')) submitBtn = b;
            });
            if (submitBtn) submitBtn.click();
            else if (btn) btn.click();
          }
        }, password);
        await new Promise(r => setTimeout(r, 3000));
        // Wait for album content to load
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
      }
    }

    // Wait a moment for lazy images to load
    await new Promise(r => setTimeout(r, 2000));

    // Extract products from the rendered DOM
    const products = await page.evaluate(() => {
      const results = [];
      const seen = new Set();

      // Find all images in the page that look like product photos
      const imgs = document.querySelectorAll('img');

      imgs.forEach(img => {
        // Try multiple src attributes (lazy loading)
        const src = img.getAttribute('data-src') || img.getAttribute('data-origin') || img.src;
        if (!src || !/\.(jpg|jpeg|png|webp)/i.test(src)) return;
        if (/logo|icon|avatar|sprite|yupoo\.com\/(icons|website|imgs)\//i.test(src)) return;
        if (src.startsWith('data:')) return;

        // Strip thumbnail paths for full-size image
        const cleanSrc = src.replace(/\/thumb\/[^/?#]+\//g, '/');
        const fname = cleanSrc.split('/').pop().split('?')[0];
        if (seen.has(fname)) return;
        seen.add(fname);

        // Name: alt text
        let name = (img.alt || '').trim();

        // Look for a parent link
        let parent = img.parentElement;
        let detailUrl = '';
        while (parent && parent !== document.body) {
          if (parent.tagName === 'A' && parent.href) {
            detailUrl = parent.href;
            break;
          }
          parent = parent.parentElement;
        }

        // Try to find name from nearby title/name elements
        if (!name || name.length < 2) {
          const container = img.closest('figure, .album__item, .image__item, [class*="image"], [class*="photo"]');
          if (container) {
            const titleEl = container.querySelector('[class*="title"], [class*="name"], figcaption');
            if (titleEl) {
              name = titleEl.textContent.trim();
            }
          }
        }

        if (!name || name.length < 2) {
          name = fname.replace(/\.(jpg|jpeg|png|webp)/i, '').replace(/[-_]/g, ' ');
        }

        results.push({
          name: name.substring(0, 120),
          thumbnail: cleanSrc,
          detailUrl: detailUrl || window.location.href,
        });
      });

      return results;
    });

    return products;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

function scrapeQiqiyg(html, baseUrl) {
  const products = [];
  const seen = new Set();

  // qiqiyg product cards: <a class="goods-item"> or <div class="goods-item">
  const itemRe = /<a[^>]*href="([^"]*)"[^>]*class="[^"]*goods[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = itemRe.exec(html)) !== null) {
    const inner = match[2];
    const imgM = inner.match(/<img[^>]*src="([^"]*)"[^>]*>/i);
    if (!imgM) continue;
    const nameM = inner.match(/<[^>]*class="[^"]*name[^"]*"[^>]*>([^<]+)</i) || inner.match(/alt="([^"]*)"/i);
    const name = nameM ? nameM[1].trim() : inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().substring(0, 80);
    const fname = imgM[1].split('/').pop().split('?')[0];
    if (seen.has(fname) || /logo|icon/i.test(fname)) continue;
    seen.add(fname);
    products.push({ name: name || 'Untitled', thumbnail: imgM[1], detailUrl: match[1].startsWith('http') ? match[1] : new URL(match[1], baseUrl).href });
  }
  return products;
}

function scrapeRicheng(html, baseUrl) {
  const products = [];
  const seen = new Set();

  // richeng86888.ru product cards
  const itemRe = /<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = itemRe.exec(html)) !== null) {
    const inner = match[2];
    const imgM = inner.match(/<img[^>]*src="([^"]*)"[^>]*>/i);
    if (!imgM) continue;
    if (!imgM[1].match(/\.(jpg|jpeg|png|webp|gif)/i)) continue;
    const fname = imgM[1].split('/').pop().split('?')[0];
    if (seen.has(fname) || /logo|icon|avatar/i.test(fname)) continue;
    seen.add(fname);
    const nameM = inner.match(/alt="([^"]*)"/i);
    const name = nameM ? nameM[1].trim() : fname.replace(/\.(jpg|jpeg|png|webp|gif)/i, '').replace(/[-_]/g, ' ');
    products.push({ name: name || 'Untitled', thumbnail: imgM[1], detailUrl: match[1].startsWith('http') ? match[1] : new URL(match[1], baseUrl).href });
  }
  return products;
}

app.post('/api/importer/scrape', requireAdmin, async (req, res) => {
  const { url, password } = req.body || {};
  if (!url) return res.status(400).json({ error: 'Missing URL' });
  if (!/yupoo\.com|qiqiyg\.com|richeng86888\.ru/i.test(url)) {
    return res.status(400).json({ error: 'Unsupported supplier. Supported: Yupoo, qiqiyg, richeng86888.ru' });
  }

  try {
    let products = [];
    if (/yupoo\.com/i.test(url)) {
      // Use headless browser for JS-rendered Yupoo pages
      products = await scrapeYupooBrowser(url, password);
    } else {
      const html = await fetchSupplierPage(url);
      if (/qiqiyg\.com/i.test(url)) products = scrapeQiqiyg(html, url);
      else if (/richeng86888\.ru/i.test(url)) products = scrapeRicheng(html, url);
    }

    // Filter out junk (very short names, likely non-products)
    products = products.filter(p => p.name && p.name.length >= 2 && p.thumbnail);

    return res.json({ products, count: products.length });
  } catch (err) {
    console.error('Importer scrape error:', err.message);
    const msg = err.message || String(err);
    if (msg.includes('Puppeteer not available') || msg.includes('Failed to launch') || msg.includes('browser')) {
      return res.status(500).json({ error: 'Browser engine unavailable. Puppeteer/Chromium may not be installed on this server. ' + msg });
    }
    if (msg.includes('timeout') || msg.includes('Timeout')) {
      return res.status(500).json({ error: 'Request timed out. The site may be slow or blocking access.' });
    }
    return res.status(500).json({ error: msg });
  }
});

// ── START ─────────────────────────────────────────────────
let server = null;

async function shutdown(signal) {
  try {
    console.log(`Shutdown initiated (${signal})`);
    if (server) {
      // stop accepting new connections
      server.close(() => console.log('Server closed'));
    }
    // allow a short grace period for connections to finish
    setTimeout(async () => {
      try {
        await pool.end();
        console.log('Database pool closed');
      } catch (e) {
        console.error('Error closing DB pool', e && e.message ? e.message : e);
      }
      process.exit(0);
    }, 500);
  } catch (e) {
    console.error('Error during shutdown', e && e.message ? e.message : e);
    process.exit(1);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception', err && err.stack ? err.stack : err);
  shutdown('uncaughtException');
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection', reason);
  shutdown('unhandledRejection');
});

initDB()
  .then(() => {
    // run cleanup at startup and schedule hourly cleanup
    cleanExpiredSessions().catch(() => {});
    setInterval(cleanExpiredSessions, 1000 * 60 * 60); // hourly

    server = app.listen(PORT, () => console.log(`UNLMTD running on port ${PORT}`));
  })
  .catch(err => {
    console.error('DB init failed:', err && err.message ? err.message : err);
    process.exit(1);
  });
