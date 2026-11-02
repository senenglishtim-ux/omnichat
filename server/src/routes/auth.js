import express from 'express';
import bcrypt from 'bcryptjs';
import { pool } from '../db/pool.js';
import { signToken, requireAuth, requireAdmin, requireUnscoped, forgetUser } from '../lib/auth.js';
import { h, bad, notFound } from './util.js';

export const authRouter = express.Router();

authRouter.post('/login', h(async (req, res) => {
  const { email, password } = req.body || {};
  const u = (await pool.query('SELECT * FROM users WHERE lower(email) = lower($1)', [String(email || '')])).rows[0];
  if (!u || !u.is_active || !(await bcrypt.compare(String(password || ''), u.password_hash))) return res.status(401).json({ error: 'invalid_credentials' });
  res.json({ token: signToken(u), user: { id: u.id, email: u.email, name: u.name, role: u.role } });
}));

authRouter.get('/me', requireAuth, (req, res) => res.json({ user: req.user }));

export const usersRouter = express.Router();
usersRouter.use(requireAuth);

usersRouter.get('/', h(async (req, res) => {
  res.json((await pool.query('SELECT id, email, name, role, is_active, created_at FROM users ORDER BY name')).rows);
}));

usersRouter.post('/', requireAdmin, h(async (req, res) => {
  const { email, name, password, role } = req.body || {};
  if (!email || !name || !password || password.length < 8) throw bad('email, name and a password of 8+ characters are required');
  const u = (await pool.query(
    'INSERT INTO users (email, name, password_hash, role) VALUES ($1,$2,$3,$4) RETURNING id, email, name, role, is_active',
    [email.trim(), name.trim(), await bcrypt.hash(password, 10), role === 'admin' ? 'admin' : 'agent'])).rows[0];
  res.status(201).json(u);
}));

usersRouter.patch('/:id', requireUnscoped, h(async (req, res) => {
  const id = Number(req.params.id);
  const self = req.user.id === id;
  if (!self && req.user.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  const { name, password, role, is_active, email } = req.body || {};
  const sets = []; const vals = [id];
  const set = (c, v) => { vals.push(v); sets.push(`${c} = $${vals.length}`); };
  if (name) set('name', name);
  if (email && req.user.role === 'admin') set('email', email);
  if (password) { if (password.length < 8) throw bad('Password must be 8+ characters'); set('password_hash', await bcrypt.hash(password, 10)); }
  if (role && req.user.role === 'admin' && !self) set('role', role === 'admin' ? 'admin' : 'agent');
  if (is_active !== undefined && req.user.role === 'admin' && !self) set('is_active', !!is_active);
  if (!sets.length) throw bad('Nothing to update');
  const u = (await pool.query(`UPDATE users SET ${sets.join(', ')} WHERE id = $1 RETURNING id, email, name, role, is_active`, vals)).rows[0];
  if (!u) throw notFound();
  forgetUser(id);
  res.json(u);
}));
