const jwt = require('jsonwebtoken');

const { AppError } = require('../utils/helpers');

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return next(new AppError(401, 'Acesso negado. Faça login para continuar.'));
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload;
    return next();
  } catch {
    return next(new AppError(401, 'Sessão expirada ou inválida. Faça login novamente.'));
  }
}

module.exports = { requireAuth };
