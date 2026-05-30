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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS catalog_data (
      id          INTEGER PRIMARY KEY DEFAULT 1,
      data        JSONB   NOT NULL,
      updated_at  TIMESTAMP DEFAULT NOW()
    );
  `);

  const existing = await pool.query('SELECT id FROM catalog_data WHERE id = 1');
  if (existing.rows.length === 0) {
    // Seed with defaults on first run
    const seedPath = path.join(__dirname, 'catalog.seed.json');
    const seed = fs.existsSync(seedPath)
      ? JSON.parse(fs.readFileSync(seedPath, 'utf8'))
      : {};
    await pool.query(
      'INSERT INTO catalog_data (id, data) VALUES (1, $1)',
      [JSON.stringify(seed)]
    );
    console.log('DB seeded with default catalog.');
  }
}

// ── AUTH MIDDLEWARE ───────────────────────────────────────
function requireAdmin(req, res, next) {
  const pw = req.headers['x-admin-password'];
  if (!pw || pw !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ── ROUTES ────────────────────────────────────────────────

// Serve the catalog
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'ecatalog.html'));
});

// Load catalog (public)
app.get('/api/catalog', async (req, res) => {
  try {
    const result = await pool.query('SELECT data FROM catalog_data WHERE id = 1');
    res.json(result.rows[0]?.data || {});
  } catch (err) {
    console.error('Load error:', err.message);
    res.status(500).json({ error: 'Failed to load catalog' });
  }
});

// Save catalog (admin only)
app.post('/api/catalog', requireAdmin, async (req, res) => {
  try {
    await pool.query(`
      INSERT INTO catalog_data (id, data, updated_at)
      VALUES (1, $1, NOW())
      ON CONFLICT (id) DO UPDATE SET data = $1, updated_at = NOW()
    `, [JSON.stringify(req.body)]);
    res.json({ success: true });
  } catch (err) {
    console.error('Save error:', err.message);
    res.status(500).json({ error: 'Failed to save catalog' });
  }
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
