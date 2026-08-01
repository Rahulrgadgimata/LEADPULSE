const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const config = require('../config/env');
const { query } = require('../config/database');

const router = express.Router();

/**
 * Register a new user
 */
router.post('/register', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    // check existing
    const existing = query('SELECT id FROM users WHERE email = ?', [email]);
    if (existing.rows.length > 0) return res.status(400).json({ error: 'User already exists' });

    const id = uuidv4();
    const hash = await bcrypt.hash(password, 10);
    const now = new Date().toISOString();

    query('INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)', [id, email, hash, now]);

    const token = jwt.sign({ id, email }, config.JWT_SECRET, { expiresIn: config.JWT_EXPIRES_IN });
    res.json({ token, user: { id, email } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Login
 */
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const result = query('SELECT * FROM users WHERE email = ?', [email]);
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const isValid = await bcrypt.compare(password, user.password_hash);
    if (!isValid) return res.status(401).json({ error: 'Invalid credentials' });

    const token = jwt.sign({ id: user.id, email: user.email }, config.JWT_SECRET, { expiresIn: config.JWT_EXPIRES_IN });
    res.json({ token, user: { id: user.id, email: user.email } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Get current user profile
 */
router.get('/me', require('../middleware/auth').auth, (req, res) => {
  res.json({ user: req.user });
});

module.exports = router;
