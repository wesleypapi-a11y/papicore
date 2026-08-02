const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const db = require('../database/database');
const { AppError, isValidEmail } = require('../utils/helpers');

function login(req, res) {
  const { email, password } = req.body || {};

  if (!isValidEmail(email) || !password) {
    throw new AppError(401, 'E-mail ou senha inválidos.');
  }

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email).trim().toLowerCase());
  if (!user) {
    throw new AppError(401, 'E-mail ou senha inválidos.');
  }

  const ok = bcrypt.compareSync(String(password), user.password_hash);
  if (!ok) {
    throw new AppError(401, 'E-mail ou senha inválidos.');
  }

  const token = jwt.sign(
    { id: user.id, name: user.name, email: user.email, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
  );

  return res.json({
    token,
    user: { id: user.id, name: user.name, email: user.email, role: user.role }
  });
}

function me(req, res) {
  const user = db.prepare('SELECT id, name, email, role, created_at FROM users WHERE id = ?').get(req.user.id);
  if (!user) {
    throw new AppError(401, 'Usuário não encontrado.');
  }
  return res.json(user);
}

module.exports = { login, me };
