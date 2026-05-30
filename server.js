const express = require('express');
const path    = require('path');
const { Pool } = require('pg');
const fs      = require('fs');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname)));

// ── DATABASE ──────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

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
    const r = await pool.query('SELECT id, category, data FROM items ORDER BY id');
    const out = {};
    r.rows.forEach(row => {
      const cat = row.category;
      if (!out[cat]) out[cat] = [];
      const item = Object.assign({ id: row.id }, row.data);
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
  if (!category || !data) return res.status(400).json({ error: 'Missing fields' });
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
  if (!id || !data) return res.status(400).json({ error: 'Missing fields' });
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

// Validate admin password
app.post('/api/auth', (req, res) => {
  const { password } = req.body;
  if (password && password === process.env.ADMIN_PASSWORD) {
    res.json({ success: true });
  } else {
    res.status(401).json({ error: 'Wrong password' });
  }
});

// ── START ─────────────────────────────────────────────────
initDB()
  .then(() => {
    app.listen(PORT, () => console.log(`UNLMTD running on port ${PORT}`));
  })
  .catch(err => {
    console.error('DB init failed:', err.message);
    process.exit(1);
  });
